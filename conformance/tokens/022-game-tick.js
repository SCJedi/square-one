// A realistic Square One tick/draw pair, to show what the budget buys.
//
// Derivation, line by line (running total in the right column):
//   const W = 128;                                          5     5
//   const H = 128;                                          5    10
//   const GRAVITY = 12;                                     5    15
//   const MAX_FALL = 240;                                   5    20
//   let px = 64;                                            5    25
//   let py = 64;                                            5    30
//   let vx = 0;                                             5    35
//   let vy = 0;                                             5    40
//   let coins = 0;                                          5    45
//   let alive = true;                                       5    50
//   function clamp(v, lo, hi) {                            10    60
//     return v < lo ? lo : v > hi ? hi : v;                15    75
//   }                                                       1    76
//   function tick(input, world) {                           8    84
//     if (!alive) {                                         6    90
//       return;                                             2    92
//     }                                                     1    93
//     vx = 0;                                               4    97
//     if (input.left) vx -= 24;                            10   107
//     if (input.right) vx += 24;                           10   117
//     vy = clamp(vy + GRAVITY, -MAX_FALL, MAX_FALL);       14   131
//     if (input.jump && world.onGround(px, py)) {          16   147
//       vy = -180;                                          5   152
//     }                                                     1   153
//     px = clamp(px + (vx >> 4), 0, W - 8);                19   172
//     py = clamp(py + (vy >> 4), 0, H - 8);                19   191
//     for (const c of world.coins) {                       10   201
//       if (!c.taken && Math.abs(c.x - px) < 6 && Math.abs(c.y - py) < 6) {
//                                                          34   235
//         c.taken = true;                                   6   241
//         coins += 1;                                       4   245
//       }                                                   1   246
//     }                                                     1   247
//     if (world.hazardAt(px, py)) {                        12   259
//       alive = false;                                      4   263
//     }                                                     1   264
//   }                                                       1   265
//   function draw(gfx) {                                    6   271
//     gfx.clear(0);                                         7   278
//     gfx.sprite(px, py, alive ? 1 : 2);                   15   293
//     gfx.text(2, 2, `coins ${coins}`);                    15   308
//   }                                                       1   309
//
// The template on the second-to-last line is 5 of that line's 15 tokens:
// chunk [`coins ], [${], [coins], [}], chunk [`].
//
// Total: 309.
const W = 128;
const H = 128;
const GRAVITY = 12;
const MAX_FALL = 240;

let px = 64;
let py = 64;
let vx = 0;
let vy = 0;
let coins = 0;
let alive = true;

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function tick(input, world) {
  if (!alive) {
    return;
  }
  vx = 0;
  if (input.left) vx -= 24;
  if (input.right) vx += 24;
  vy = clamp(vy + GRAVITY, -MAX_FALL, MAX_FALL);
  if (input.jump && world.onGround(px, py)) {
    vy = -180;
  }
  px = clamp(px + (vx >> 4), 0, W - 8);
  py = clamp(py + (vy >> 4), 0, H - 8);
  for (const c of world.coins) {
    if (!c.taken && Math.abs(c.x - px) < 6 && Math.abs(c.y - py) < 6) {
      c.taken = true;
      coins += 1;
    }
  }
  if (world.hazardAt(px, py)) {
    alive = false;
  }
}

function draw(gfx) {
  gfx.clear(0);
  gfx.sprite(px, py, alive ? 1 : 2);
  gfx.text(2, 2, `coins ${coins}`);
}
