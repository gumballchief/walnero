// Walnero's scanner: finds which Monero transactions belong to a wallet, reading the feed, as fast as a browser can go.
//
// It answers "is this ours?" and nothing else. It holds no spend key and moves no money. wallet2 stays the source of truth.
//
// The speed comes from doing the same maths as Monero's shared secret D = 8*a*R with far less work:
//   - The X25519 ladder needs only the y coordinate of R, so no square root and no safety checks per key.
//   - Every ladder here uses the same scalar, so two run side by side in one SIMD register.
//   - Field multiplies use fused multiply-add on doubles: two FMAs give the exact high and low halves of a 102 bit product.
//     WebAssembly has no 64x64 bit integer multiply, so this is several times quicker than integer limbs.
//   - u loses the sign of x, so each D has two candidates. Both get a view tag check, then the one-time key settles it.
//
// A CPU without real FMA would give wrong low halves. self_test() catches that and scanning falls back to the slow, plain path.
#![no_std]
#![allow(static_mut_refs)]

use core::arch::wasm32::*;
use curve25519_dalek::edwards::{CompressedEdwardsY, EdwardsPoint};
use curve25519_dalek::scalar::Scalar;

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! { core::arch::wasm32::unreachable() }

// --- Memory -------------------------------------------------------------------------------------------------------------

#[no_mangle]
pub extern "C" fn alloc(n: usize) -> *mut u8 {
    let pages = (n + 65535) / 65536;
    let old = memory_grow(0, pages);
    if old == usize::MAX { return core::ptr::null_mut(); }
    (old * 65536) as *mut u8
}

// --- Field arithmetic mod 2^255-19: two values at once, five signed limbs held as doubles ---------------------------------

const T51: f64 = (1u64 << 51) as f64;
const C1: f64 = 3.0 * T51 * T51; // 3*2^102: keeps a*b + C1 inside one binade, whose last bit is worth 2^51
const C3: f64 = 3.0 * T51; // 3*2^51: keeps the low half inside the binade whose last bit is worth 1
const C2: f64 = C1 + C3;
const B1: u64 = C1.to_bits();
const B3: u64 = C3.to_bits();

#[derive(Clone, Copy)]
struct F([v128; 5]);

#[inline(always)] fn splat(x: f64) -> v128 { f64x2_splat(x) }

// The fused multiply-add. Engines without relaxed SIMD (some Safari versions) can't even load a module that uses it, so a
// second build, walnero_scan_plain.wasm, swaps in a plain multiply and add. That isn't exact, self_test() sees it, and
// scanning takes the plain path.
#[cfg(target_feature = "relaxed-simd")]
#[inline(always)] fn fma(a: v128, b: v128, c: v128) -> v128 { f64x2_relaxed_madd(a, b, c) }
#[cfg(not(target_feature = "relaxed-simd"))]
#[inline(always)] fn fma(a: v128, b: v128, c: v128) -> v128 { f64x2_add(f64x2_mul(a, b), c) }

// a*b = hi*2^51 + lo, exactly, as raw bit patterns that are later summed as integers.
#[inline(always)]
fn prod(a: v128, b: v128, c1: v128, c2: v128) -> (v128, v128) {
    let hi = fma(a, b, c1);
    let lo = fma(a, b, f64x2_sub(c2, hi));
    (hi, lo)
}

#[inline(always)] fn add64(a: v128, b: v128) -> v128 { i64x2_add(a, b) }
#[inline(always)] fn sub64(a: v128, b: v128) -> v128 { i64x2_sub(a, b) }
#[inline(always)] fn times19(x: v128) -> v128 { add64(add64(x, i64x2_shl(x, 1)), i64x2_shl(x, 4)) }
#[inline(always)]
fn carry(r: v128, round: v128) -> (v128, v128) {
    let q = i64x2_shr(add64(r, round), 51);
    (sub64(r, i64x2_shl(q, 51)), q)
}

// Brings integer limbs back to |limb| <= 2^50 and into doubles. The sum of two such limbs still multiplies safely.
#[inline(always)]
fn settle(mut r: [v128; 5]) -> F {
    let round = i64x2_splat(1 << 50);
    let mut q;
    (r[0], q) = carry(r[0], round); r[1] = add64(r[1], q);
    (r[1], q) = carry(r[1], round); r[2] = add64(r[2], q);
    (r[2], q) = carry(r[2], round); r[3] = add64(r[3], q);
    (r[3], q) = carry(r[3], round); r[4] = add64(r[4], q);
    (r[4], q) = carry(r[4], round); r[0] = add64(r[0], times19(q));
    (r[0], q) = carry(r[0], round); r[1] = add64(r[1], q);
    let bias = u64x2_splat(B3);
    let c3 = splat(C3);
    F([
        f64x2_sub(add64(r[0], bias), c3),
        f64x2_sub(add64(r[1], bias), c3),
        f64x2_sub(add64(r[2], bias), c3),
        f64x2_sub(add64(r[3], bias), c3),
        f64x2_sub(add64(r[4], bias), c3),
    ])
}

include!("field_gen.rs");

#[inline(always)]
fn mul_121665(a: &F) -> F {
    let k = splat(121665.0);
    let (c1, c2) = (splat(C1), splat(C2));
    let mut c = [i64x2_splat(0); 6];
    let mut i = 0;
    while i < 5 {
        let (hi, lo) = prod(a.0[i], k, c1, c2);
        c[i] = add64(c[i], sub64(lo, u64x2_splat(B3)));
        c[i + 1] = add64(c[i + 1], sub64(hi, u64x2_splat(B1)));
        i += 1;
    }
    settle([add64(c[0], times19(c[5])), c[1], c[2], c[3], c[4]])
}

#[inline(always)]
fn add(a: &F, b: &F) -> F {
    F([f64x2_add(a.0[0], b.0[0]), f64x2_add(a.0[1], b.0[1]), f64x2_add(a.0[2], b.0[2]), f64x2_add(a.0[3], b.0[3]), f64x2_add(a.0[4], b.0[4])])
}
#[inline(always)]
fn sub(a: &F, b: &F) -> F {
    F([f64x2_sub(a.0[0], b.0[0]), f64x2_sub(a.0[1], b.0[1]), f64x2_sub(a.0[2], b.0[2]), f64x2_sub(a.0[3], b.0[3]), f64x2_sub(a.0[4], b.0[4])])
}

fn constant(x: f64) -> F { F([splat(x), splat(0.0), splat(0.0), splat(0.0), splat(0.0)]) }

fn square_times(a: &F, n: u32) -> F {
    let mut x = *a;
    let mut i = 0;
    while i < n { x = sqr(&x); i += 1; }
    x
}

// a^(p-2), both lanes at once. Zero stays zero.
fn invert(z: &F) -> F {
    let z2 = sqr(z);
    let z9 = mul(&square_times(&z2, 2), z);
    let z11 = mul(&z9, &z2);
    let z2_5 = mul(&sqr(&z11), &z9);
    let z2_10 = mul(&square_times(&z2_5, 5), &z2_5);
    let z2_20 = mul(&square_times(&z2_10, 10), &z2_10);
    let z2_40 = mul(&square_times(&z2_20, 20), &z2_20);
    let z2_50 = mul(&square_times(&z2_40, 10), &z2_10);
    let z2_100 = mul(&square_times(&z2_50, 50), &z2_50);
    let z2_200 = mul(&square_times(&z2_100, 100), &z2_100);
    let z2_250 = mul(&square_times(&z2_200, 50), &z2_50);
    mul(&square_times(&z2_250, 5), &z11)
}

fn lane_limbs(a: &F, lane: usize) -> [i64; 5] {
    let bias = splat(C3);
    let mut out = [0i64; 5];
    let mut i = 0;
    while i < 5 {
        let bits = sub64(f64x2_add(a.0[i], bias), i64x2_splat(B3 as i64));
        out[i] = if lane == 0 { i64x2_extract_lane::<0>(bits) } else { i64x2_extract_lane::<1>(bits) };
        i += 1;
    }
    out
}

fn limbs_to_bytes(l: [i64; 5]) -> [u8; 32] {
    let mut t = l;
    let mut pass = 0;
    while pass < 3 {
        let mut i = 0;
        while i < 4 { let c = t[i] >> 51; t[i] -= c << 51; t[i + 1] += c; i += 1; }
        let c = t[4] >> 51; t[4] -= c << 51; t[0] += 19 * c;
        pass += 1;
    }
    let mut q = (t[0] + 19) >> 51;
    q = (t[1] + q) >> 51; q = (t[2] + q) >> 51; q = (t[3] + q) >> 51; q = (t[4] + q) >> 51;
    t[0] += 19 * q;
    let mut i = 0;
    while i < 4 { let c = t[i] >> 51; t[i] -= c << 51; t[i + 1] += c; i += 1; }
    t[4] &= (1 << 51) - 1;
    let (a, b, c, d, e) = (t[0] as u64, t[1] as u64, t[2] as u64, t[3] as u64, t[4] as u64);
    let words = [a | (b << 51), (b >> 13) | (c << 38), (c >> 26) | (d << 25), (d >> 39) | (e << 12)];
    let mut out = [0u8; 32];
    let mut w = 0;
    while w < 4 {
        let bytes = words[w].to_le_bytes();
        let mut k = 0;
        while k < 8 { out[w * 8 + k] = bytes[k]; k += 1; }
        w += 1;
    }
    out
}

fn load_limbs(p: *const u8) -> [i64; 5] {
    let word = |at: usize| unsafe { u64::from_le_bytes(core::ptr::read_unaligned(p.add(at) as *const [u8; 8])) };
    let m = (1u64 << 51) - 1;
    [
        (word(0) & m) as i64,
        ((word(6) >> 3) & m) as i64,
        ((word(12) >> 6) & m) as i64,
        ((word(19) >> 1) & m) as i64,
        ((word(24) >> 12) & m) as i64,
    ]
}

fn pair(a: &[i64; 5], b: &[i64; 5]) -> F {
    settle([i64x2(a[0], b[0]), i64x2(a[1], b[1]), i64x2(a[2], b[2]), i64x2(a[3], b[3]), i64x2(a[4], b[4])])
}

fn lane_is_zero(a: &F, lane: usize) -> bool { limbs_to_bytes(lane_limbs(a, lane)) == [0u8; 32] }

// The ladder. Both lanes take the same steps because they share one scalar, and the swap never branches on a key bit.
#[inline(never)]
fn ladder(scalar: &[u8; 32], u: &F) -> (F, F) {
    let mut x2 = constant(1.0);
    let mut z2 = constant(0.0);
    let mut x3 = *u;
    let mut z3 = constant(1.0);
    let mut swap = 0u8;
    let mut t: i32 = 254;
    while t >= 0 {
        let bit = (scalar[(t / 8) as usize] >> (t % 8)) & 1;
        let mask = u64x2_splat(0u64.wrapping_sub((swap ^ bit) as u64));
        cswap(mask, &mut x2, &mut x3);
        cswap(mask, &mut z2, &mut z3);
        swap = bit;
        let a = add(&x2, &z2);
        let b = sub(&x2, &z2);
        let c = add(&x3, &z3);
        let d = sub(&x3, &z3);
        let aa = sqr(&a);
        let bb = sqr(&b);
        let e = sub(&aa, &bb);
        let da = mul(&d, &a);
        let cb = mul(&c, &b);
        x3 = sqr(&add(&da, &cb));
        z3 = mul(u, &sqr(&sub(&da, &cb)));
        x2 = mul(&aa, &bb);
        z2 = mul(&e, &add(&aa, &mul_121665(&e)));
        t -= 1;
    }
    let mask = u64x2_splat(0u64.wrapping_sub(swap as u64));
    cswap(mask, &mut x2, &mut x3);
    cswap(mask, &mut z2, &mut z3);
    (x2, z2)
}

#[inline(always)]
fn cswap(mask: v128, a: &mut F, b: &mut F) {
    let mut i = 0;
    while i < 5 {
        let (x, y) = (a.0[i], b.0[i]);
        a.0[i] = v128_bitselect(y, x, mask);
        b.0[i] = v128_bitselect(x, y, mask);
        i += 1;
    }
}

const PAIRS: usize = 64;

// Inverts many pairs for the cost of one inversion. A zero lane would poison the rest, so that case inverts one at a time.
fn invert_batch(items: &[F; PAIRS], out: &mut [F; PAIRS], n: usize) {
    let mut running = [constant(1.0); PAIRS];
    running[0] = items[0];
    let mut i = 1;
    while i < n { running[i] = mul(&running[i - 1], &items[i]); i += 1; }
    let last = &running[n - 1];
    if lane_is_zero(last, 0) || lane_is_zero(last, 1) {
        let mut i = 0;
        while i < n { out[i] = invert(&items[i]); i += 1; }
        return;
    }
    let mut inv = invert(last);
    let mut i = n - 1;
    while i > 0 {
        out[i] = mul(&inv, &running[i - 1]);
        inv = mul(&inv, &items[i]);
        i -= 1;
    }
    out[0] = inv;
}

// --- The wallet's keys ---------------------------------------------------------------------------------------------------

const P: [u8; 32] = [0xed, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f];
const L_HIGH: [u64; 4] = [0x5812631a5cf5d3ed, 0x14def9dea2f79cd6, 0, 0x1000000000000000];

static mut VIEW: [u8; 32] = [0; 32];
static mut LADDER_SCALAR: [u8; 32] = [0; 32];
static mut FAST: bool = false;
static mut TABLE: *const u8 = core::ptr::null();
static mut TABLE_N: usize = 0;
static mut KI: *const u32 = core::ptr::null();
static mut KI_N: usize = 0;

fn words(p: *const u8) -> [u64; 4] {
    let mut out = [0u64; 4];
    let mut i = 0;
    while i < 4 { out[i] = unsafe { u64::from_le_bytes(core::ptr::read_unaligned(p.add(i * 8) as *const [u8; 8])) }; i += 1; }
    out
}
fn sub_words(a: &[u64; 4], b: &[u64; 4]) -> [u64; 4] {
    let mut out = [0u64; 4];
    let mut borrow = false;
    let mut i = 0;
    while i < 4 {
        let (x, b1) = a[i].overflowing_sub(b[i]);
        let (y, b2) = x.overflowing_sub(borrow as u64);
        out[i] = y;
        borrow = b1 || b2;
        i += 1;
    }
    out
}
fn at_least_2_251(w: &[u64; 4]) -> bool { w[3] >> 59 != 0 }
fn below_2_252(w: &[u64; 4]) -> bool { w[3] >> 60 == 0 }

/// 8*a as an X25519 scalar. If a is under 2^251, l-a fits instead and gives -D, whose y is the same. Returns false in the
/// 1 in 2^125 case neither fits, and then the plain path does the work.
fn make_ladder_scalar(view: &[u8; 32]) -> bool {
    let a = words(view.as_ptr());
    let fit = if at_least_2_251(&a) && below_2_252(&a) { a } else { sub_words(&L_HIGH, &a) };
    if !at_least_2_251(&fit) || !below_2_252(&fit) { return false; }
    let eight = [fit[0] << 3, (fit[1] << 3) | (fit[0] >> 61), (fit[2] << 3) | (fit[1] >> 61), (fit[3] << 3) | (fit[2] >> 61)];
    let mut i = 0;
    while i < 4 {
        let bytes = eight[i].to_le_bytes();
        let mut k = 0;
        unsafe { while k < 8 { LADDER_SCALAR[i * 8 + k] = bytes[k]; k += 1; } }
        i += 1;
    }
    true
}

// Keccak-256, the original padding Monero uses. Every message here fits in one 136 byte block.
const ROUNDS: [u64; 24] = [
    0x0000000000000001, 0x0000000000008082, 0x800000000000808a, 0x8000000080008000, 0x000000000000808b, 0x0000000080000001,
    0x8000000080008081, 0x8000000000008009, 0x000000000000008a, 0x0000000000000088, 0x0000000080008009, 0x000000008000000a,
    0x000000008000808b, 0x800000000000008b, 0x8000000000008089, 0x8000000000008003, 0x8000000000008002, 0x8000000000000080,
    0x000000000000800a, 0x800000008000000a, 0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008,
];
const ROTATE: [u32; 24] = [1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14, 27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44];
const LANE: [usize; 24] = [10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1];

#[inline(always)]
fn keccak_f(a: &mut [u64; 25]) {
    let mut round = 0;
    while round < 24 {
        let mut c = [0u64; 5];
        let mut x = 0;
        while x < 5 { c[x] = a[x] ^ a[x + 5] ^ a[x + 10] ^ a[x + 15] ^ a[x + 20]; x += 1; }
        let mut x = 0;
        while x < 5 {
            let d = c[(x + 4) % 5] ^ c[(x + 1) % 5].rotate_left(1);
            let mut y = 0;
            while y < 25 { a[y + x] ^= d; y += 5; }
            x += 1;
        }
        let mut last = a[1];
        let mut i = 0;
        while i < 24 {
            let lane = LANE[i];
            let next = a[lane];
            a[lane] = last.rotate_left(ROTATE[i]);
            last = next;
            i += 1;
        }
        let mut y = 0;
        while y < 25 {
            let row = [a[y], a[y + 1], a[y + 2], a[y + 3], a[y + 4]];
            let mut x = 0;
            while x < 5 { a[y + x] = row[x] ^ (!row[(x + 1) % 5] & row[(x + 2) % 5]); x += 1; }
            y += 5;
        }
        a[0] ^= ROUNDS[round];
        round += 1;
    }
}

fn keccak(parts: &[&[u8]]) -> [u8; 32] {
    let mut block = [0u8; 136];
    let mut at = 0;
    let mut i = 0;
    while i < parts.len() {
        block[at..at + parts[i].len()].copy_from_slice(parts[i]);
        at += parts[i].len();
        i += 1;
    }
    block[at] = 0x01;
    block[135] |= 0x80;
    let mut a = [0u64; 25];
    let mut i = 0;
    while i < 17 {
        a[i] = u64::from_le_bytes(block[i * 8..i * 8 + 8].try_into().unwrap());
        i += 1;
    }
    keccak_f(&mut a);
    let mut out = [0u8; 32];
    let mut i = 0;
    while i < 4 {
        out[i * 8..i * 8 + 8].copy_from_slice(&a[i].to_le_bytes());
        i += 1;
    }
    out
}

/// Fills the table of spend keys this wallet could receive on: the main key plus subaddress keys, as wallet2 looks ahead.
/// Layout: 32 bytes each, sorted. Returns how many were written.
#[no_mangle]
pub extern "C" fn make_table(view_ptr: *const u8, spend_ptr: *const u8, majors: u32, minors: u32, out: *mut u8) -> u32 {
    let view = unsafe { core::slice::from_raw_parts(view_ptr, 32) };
    let spend = unsafe { core::ptr::read_unaligned(spend_ptr as *const [u8; 32]) };
    let Some(base) = CompressedEdwardsY(spend).decompress() else { return 0 };
    let total = (majors * minors) as usize;
    let table = unsafe { core::slice::from_raw_parts_mut(out as *mut [u8; 32], total) };
    let mut n = 0;
    let mut major = 0;
    while major < majors {
        let mut minor = 0;
        while minor < minors {
            table[n] = if major == 0 && minor == 0 {
                spend
            } else {
                let m = keccak(&[b"SubAddr\0", view, &major.to_le_bytes(), &minor.to_le_bytes()]);
                (base + EdwardsPoint::mul_base(&Scalar::from_bytes_mod_order(m))).compress().0
            };
            n += 1;
            minor += 1;
        }
        major += 1;
    }
    table.sort_unstable();
    n as u32
}

/// table: sorted 32 byte spend keys. key_images: sorted first-4-bytes of the key images of coins we hold. Returns 1 for the
/// fast path, 0 for the plain one.
#[no_mangle]
pub extern "C" fn set_keys(view_ptr: *const u8, table: *const u8, table_n: u32, key_images: *const u32, ki_n: u32) -> u32 {
    unsafe {
        core::ptr::copy_nonoverlapping(view_ptr, VIEW.as_mut_ptr(), 32);
        TABLE = table;
        TABLE_N = table_n as usize;
        KI = key_images;
        KI_N = ki_n as usize;
        let view = VIEW;
        FAST = make_ladder_scalar(&view) && self_test();
        FAST as u32
    }
}

fn ours(key: &[u8; 32]) -> bool {
    let table = unsafe { core::slice::from_raw_parts(TABLE as *const [u8; 32], TABLE_N) };
    table.binary_search(key).is_ok()
}

fn spent_by_us(prefix: u32) -> bool {
    let list = unsafe { core::slice::from_raw_parts(KI, KI_N) };
    list.binary_search(&prefix).is_ok()
}

/// Checks fused multiply-add really is fused here, and that the fast path matches a plain, independent curve library.
#[no_mangle]
pub extern "C" fn self_test() -> bool {
    // Exactness of the two halves on values that need every bit.
    let a = splat(2251799813685247.0);
    let b = splat(-2251799813685245.0);
    let (hi, lo) = prod(a, b, splat(C1), splat(C2));
    let h = i64x2_extract_lane::<0>(sub64(hi, i64x2_splat(B1 as i64))) as i128;
    let l = i64x2_extract_lane::<0>(sub64(lo, i64x2_splat(B3 as i64))) as i128;
    if h * (1i128 << 51) + l != 2251799813685247i128 * -2251799813685245i128 { return false; }

    let scalar = Scalar::from_bytes_mod_order(keccak(&[b"walnero self test"]));
    let view = scalar.to_bytes();
    let saved = unsafe { LADDER_SCALAR };
    let good = make_ladder_scalar(&view) && {
        let mut ok = true;
        let mut i = 0u8;
        while i < 8 {
            let r = EdwardsPoint::mul_base(&Scalar::from_bytes_mod_order(keccak(&[b"walnero self test key", &[i]])));
            let bytes = r.compress().0;
            let want = (scalar * r).mul_by_cofactor().compress().0;
            let got = derive_one(&bytes);
            let mut y = want;
            y[31] &= 0x7f;
            if got != y { ok = false; }
            i += 1;
        }
        ok
    };
    unsafe { LADDER_SCALAR = saved; }
    good
}

fn derive_one(r: &[u8; 32]) -> [u8; 32] {
    let mut keys = [[0u8; 32]; 2];
    keys[0] = *r;
    keys[1] = *r;
    let mut ptrs = [core::ptr::null(); PAIRS * 2];
    ptrs[0] = keys[0].as_ptr();
    ptrs[1] = keys[1].as_ptr();
    let mut out = [[0u8; 32]; PAIRS * 2];
    derive_batch(&ptrs, 2, &mut out);
    out[0]
}

// Encodings whose order divides 8 (y = 1, -1, 0, the two order 8 values, and the two non-canonical spellings of 0 and 1).
// 8*a*R is the identity for these, and wallet2 would use exactly that.
const LOW_ORDER: [[u8; 32]; 7] = [
    [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0xec, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f],
    [0; 32],
    [0x26, 0xe8, 0x95, 0x8f, 0xc2, 0xb2, 0x27, 0xb0, 0x45, 0xc3, 0xf4, 0x89, 0xf2, 0xef, 0x98, 0xf0, 0xd5, 0xdf, 0xac, 0x05, 0xd3, 0xc6, 0x33, 0x39, 0xb1, 0x38, 0x02, 0x88, 0x6d, 0x53, 0xfc, 0x05],
    [0xc7, 0x17, 0x6a, 0x70, 0x3d, 0x4d, 0xd8, 0x4f, 0xba, 0x3c, 0x0b, 0x76, 0x0d, 0x10, 0x67, 0x0f, 0x2a, 0x20, 0x53, 0xfa, 0x2c, 0x39, 0xcc, 0xc6, 0x4e, 0xc7, 0xfd, 0x77, 0x92, 0xac, 0x03, 0x7a],
    P,
    [0xee, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f],
];

fn is_low_order(p: *const u8) -> bool {
    let mut k = unsafe { core::ptr::read_unaligned(p as *const [u8; 32]) };
    k[31] &= 0x7f;
    let mut i = 0;
    while i < LOW_ORDER.len() {
        if k == LOW_ORDER[i] { return true; }
        i += 1;
    }
    false
}

const IDENTITY_Y: [u8; 32] = [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

// y of D for up to 128 tx keys. x loses its sign here; the caller tries both.
fn derive_batch(keys: &[*const u8; PAIRS * 2], n: usize, out: &mut [[u8; 32]; PAIRS * 2]) {
    let scalar = unsafe { LADDER_SCALAR };
    let one = constant(1.0);
    let mut ys = [constant(0.0); PAIRS];
    let mut low = [false; PAIRS * 2];
    let filler = [1i64, 0, 0, 0, 2]; // A placeholder y for a low order key, so the batch stays invertible.
    let pairs = (n + 1) / 2;
    let mut m = 0;
    while m < pairs {
        let a = 2 * m;
        let b = if a + 1 < n { a + 1 } else { a };
        low[a] = is_low_order(keys[a]);
        low[b] = is_low_order(keys[b]);
        let la = if low[a] { filler } else { load_limbs(keys[a]) };
        let lb = if low[b] { filler } else { load_limbs(keys[b]) };
        ys[m] = pair(&la, &lb);
        m += 1;
    }
    let mut dens = [one; PAIRS];
    let mut m = 0;
    while m < pairs { dens[m] = sub(&one, &ys[m]); m += 1; }
    let mut inv = [one; PAIRS];
    invert_batch(&dens, &mut inv, pairs);
    let mut x_minus = [one; PAIRS];
    let mut x_plus = [one; PAIRS];
    let mut m = 0;
    while m < pairs {
        let u = mul(&add(&one, &ys[m]), &inv[m]);
        let (x, z) = ladder(&scalar, &u);
        // Squeezing limbs here keeps later sums in range.
        x_minus[m] = sub(&x, &z);
        x_plus[m] = add(&x, &z);
        m += 1;
    }
    invert_batch(&x_plus, &mut inv, pairs);
    let mut m = 0;
    while m < pairs {
        let y = mul(&x_minus[m], &inv[m]);
        let a = 2 * m;
        out[a] = if low[a] { IDENTITY_Y } else { limbs_to_bytes(lane_limbs(&y, 0)) };
        if a + 1 < n { out[a + 1] = if low[a + 1] { IDENTITY_Y } else { limbs_to_bytes(lane_limbs(&y, 1)) }; }
        m += 1;
    }
}

// --- Reading a feed chunk ------------------------------------------------------------------------------------------------
//
// "WNF" version(1) start:u32 blocks:u32 txs:u32, then a u16 tx count per block, then per transaction, miner transaction first:
//   flags:u8 (1 = has view tags, 2 = has per-output keys)  keys:u8  key*32...  outs:varint  [per-output key*32...]
//   per output: [tag:u8] one-time-key*32   inputs:varint  key-image-prefix*4...

#[derive(Clone, Copy)]
struct KeyRef { r: *const u8, outs: *const u8, n_out: u32, single: i32, tagged: bool, block: u32, tx: u32 }

const NO_REF: KeyRef = KeyRef { r: core::ptr::null(), outs: core::ptr::null(), n_out: 0, single: -1, tagged: true, block: 0, tx: 0 };

struct Scan { out: *mut u32, cap: u32, n: u32, keccaks: u64, candidates: u64 }

impl Scan {
    fn hit(&mut self, block: u32, tx: u32, kind: u32) {
        if self.n >= self.cap { return; }
        unsafe {
            let at = self.out.add((self.n * 3) as usize);
            *at = block; *at.add(1) = tx; *at.add(2) = kind;
        }
        self.n += 1;
    }
}

fn varint_len(n: u32, buf: &mut [u8]) -> usize {
    let mut v = n;
    let mut i = 0;
    while v >= 0x80 { buf[i] = (v as u8 & 0x7f) | 0x80; v >>= 7; i += 1; }
    buf[i] = v as u8;
    i + 1
}

fn read_varint(p: &mut *const u8, end: usize) -> Option<u32> {
    let mut v = 0u32;
    let mut shift = 0;
    unsafe {
        loop {
            if *p as usize >= end || shift > 28 { return None; }
            let b = **p;
            *p = p.add(1);
            v |= ((b & 0x7f) as u32) << shift;
            if b & 0x80 == 0 { return Some(v); }
            shift += 7;
        }
    }
}

// A tag matched. Does the one-time key really come from one of this wallet's spend keys?
fn settle_candidate(d: &[u8; 32], index: u32, one_time: *const u8) -> bool {
    let mut tail = [0u8; 10];
    let size = varint_len(index, &mut tail);
    let s = Scalar::from_bytes_mod_order(keccak(&[d, &tail[..size]]));
    let key = unsafe { core::ptr::read_unaligned(one_time as *const [u8; 32]) };
    let Some(p) = CompressedEdwardsY(key).decompress() else { return false };
    ours(&(p - EdwardsPoint::mul_base(&s)).compress().0)
}

// Output layout for one key reference: [tag] + one-time key per output.
fn check_key(scan: &mut Scan, y: &[u8; 32], k: &KeyRef) {
    let step = if k.tagged { 33 } else { 32 };
    let mut buf = [0u8; 8 + 32 + 10];
    buf[..8].copy_from_slice(b"view_tag");
    buf[8..40].copy_from_slice(y);
    let (first, last) = if k.single >= 0 { (k.single as u32, k.single as u32 + 1) } else { (0, k.n_out) };
    let mut i = first;
    while i < last {
        let entry = unsafe { k.outs.add(i as usize * step) };
        let (tag, one_time) = if k.tagged { (unsafe { *entry }, unsafe { entry.add(1) }) } else { (0, entry) };
        let size = 40 + varint_len(i, &mut buf[40..]);
        let mut sign = 0u8;
        while sign < 2 {
            buf[39] = (y[31] & 0x7f) | (sign << 7);
            let matched = if k.tagged {
                scan.keccaks += 1;
                keccak(&[&buf[..size]])[0] == tag
            } else { true };
            if matched {
                scan.candidates += 1;
                let mut d = *y;
                d[31] = buf[39];
                if settle_candidate(&d, i, one_time) { scan.hit(k.block, k.tx, 0); break; }
            }
            sign += 1;
        }
        i += 1;
    }
}

fn flush(scan: &mut Scan, refs: &[KeyRef; PAIRS * 2], n: usize) {
    if n == 0 { return; }
    let mut ys = [[0u8; 32]; PAIRS * 2];
    if unsafe { FAST } {
        let mut keys = [core::ptr::null(); PAIRS * 2];
        let mut i = 0;
        while i < n { keys[i] = refs[i].r; i += 1; }
        derive_batch(&keys, n, &mut ys);
    } else {
        // The plain path: slower, but needs no special CPU instruction.
        let scalar = Scalar::from_bytes_mod_order(unsafe { VIEW });
        let mut i = 0;
        while i < n {
            let key = unsafe { core::ptr::read_unaligned(refs[i].r as *const [u8; 32]) };
            ys[i] = match CompressedEdwardsY(key).decompress() {
                Some(point) => (scalar * point).mul_by_cofactor().compress().0,
                None => { let mut skip = [0u8; 32]; skip[0] = 0xff; skip }
            };
            i += 1;
        }
    }
    let mut i = 0;
    while i < n { check_key(scan, &ys[i], &refs[i]); i += 1; }
}

/// Scans one feed chunk. Writes hits as (block index, tx index, kind) with kind 0 = coins to us, 1 = our coins spent.
/// per_block gets each block's output count, then each block's byte offset, then the end offset, so 2*blocks+1 values.
/// Returns the number of hits, or a negative number if the file is damaged. The file is never trusted: a hostile one can only
/// stop the scan, because every length it claims is checked before use.
#[no_mangle]
pub extern "C" fn scan_chunk(chunk: *const u8, len: usize, out: *mut u32, cap: u32, per_block: *mut u32) -> i32 {
    if len < 16 { return -1; }
    let end = chunk as usize + len;
    let head = unsafe { core::slice::from_raw_parts(chunk, 16) };
    if &head[..3] != b"WNF" || head[3] != 1 { return -2; }
    let blocks = u32::from_le_bytes([head[8], head[9], head[10], head[11]]);
    if blocks as usize > (len - 16) / 2 { return -3; }
    let counts = unsafe { chunk.add(16) };
    let mut p = unsafe { counts.add(blocks as usize * 2) };

    let mut scan = Scan { out, cap, n: 0, keccaks: 0, candidates: 0 };
    let mut refs = [NO_REF; PAIRS * 2];
    let mut n = 0;
    let mut block = 0u32;
    while block < blocks {
        unsafe { *per_block.add((blocks + block) as usize) = (p as usize - chunk as usize) as u32; }
        let mut outputs = 0u32;
        let txs = unsafe { u16::from_le_bytes([*counts.add(block as usize * 2), *counts.add(block as usize * 2 + 1)]) } as u32;
        let mut tx = 0u32;
        while tx < txs {
            if end - (p as usize) < 2 { return -4; }
            let flags = unsafe { *p };
            let n_keys = unsafe { *p.add(1) } as usize;
            p = unsafe { p.add(2) };
            if end - (p as usize) < n_keys * 32 { return -5; }
            let keys = p;
            p = unsafe { p.add(n_keys * 32) };
            let Some(n_out) = read_varint(&mut p, end) else { return -5 };
            let per_output = flags & 2 != 0;
            let extras = p;
            if per_output {
                if n_out as usize > (end - p as usize) / 32 { return -6; }
                p = unsafe { p.add(n_out as usize * 32) };
            }
            let tagged = flags & 1 != 0;
            let step = if tagged { 33 } else { 32 };
            let outs = p;
            if n_out as usize > (end - p as usize) / step { return -6; }
            p = unsafe { p.add(n_out as usize * step) };
            outputs = outputs.wrapping_add(n_out);
            let Some(n_in) = read_varint(&mut p, end) else { return -7 };
            if n_in as usize > (end - p as usize) / 4 { return -7; }
            let mut i = 0;
            while i < n_in {
                if unsafe { KI_N } > 0 {
                    let prefix = unsafe { core::ptr::read_unaligned(p as *const u32) };
                    if spent_by_us(prefix) { scan.hit(block, tx, 1); }
                }
                p = unsafe { p.add(4) };
                i += 1;
            }

            let mut k = 0;
            while k < n_keys {
                refs[n] = KeyRef { r: unsafe { keys.add(k * 32) }, outs, n_out, single: -1, tagged, block, tx };
                n += 1;
                if n == PAIRS * 2 { flush(&mut scan, &refs, n); n = 0; }
                k += 1;
            }
            if per_output {
                let mut j = 0;
                while j < n_out {
                    refs[n] = KeyRef { r: unsafe { extras.add(j as usize * 32) }, outs, n_out, single: j as i32, tagged, block, tx };
                    n += 1;
                    if n == PAIRS * 2 { flush(&mut scan, &refs, n); n = 0; }
                    j += 1;
                }
            }
            tx += 1;
        }
        unsafe { *per_block.add(block as usize) = outputs; }
        block += 1;
    }
    unsafe { *per_block.add(blocks as usize * 2) = (p as usize - chunk as usize) as u32; }
    if p as usize != end { return -8; }
    flush(&mut scan, &refs, n);
    scan.n as i32
}

/// Test only: y of D for one key, so the test can compare against an independent library.
#[no_mangle]
pub extern "C" fn test_derive(key: *const u8, out: *mut u8) {
    let k = unsafe { core::ptr::read_unaligned(key as *const [u8; 32]) };
    let y = derive_one(&k);
    unsafe { core::ptr::copy_nonoverlapping(y.as_ptr(), out, 32); }
}
