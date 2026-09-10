// Hello, Square One.
//
// A bouncing block over a rippling horizon. It is the smallest complete cart:
// copy this directory, change the title in cart.json, and edit this file.
//
//     sq1 build examples/hello
//     sq1 inspect examples/hello.cart
//
// There is no compile step and no bundler. This file IS the cart's code, and
// it stays readable inside the .cart forever -- anyone who plays it can read
// it.
//
// TWO ENTRY POINTS
//   boot()   runs once, before the first frame. Set up state here.
//   tick()   runs exactly once per frame, sixty times a second. Draw here.
//
// WHAT IS NOT HERE
//   No Math, no Date, no fetch, no network, no localStorage. They are deleted
//   from the cart's global scope before this file runs, so a cart cannot
//   depend on anything that differs between two machines. Use sys.sin, sys.cos
//   and sys.rnd instead of Math; use sys.frame() instead of a clock. That is
//   what makes a replay recorded in Chrome play back identically in Firefox.
//
// WHERE STATE LIVES
//   In RAM, through sys.peek and sys.poke. A value kept in a variable up here
//   would look fine on a straight run and quietly disagree with itself the
//   first time a player rewinds, because a rewind restores RAM and cannot
//   restore a variable it cannot see. RAM from 0x7800 up is the cart's own.

var USER_RAM = 0x7800;

var X = USER_RAM + 0; // block position, in pixels
var Y = USER_RAM + 1;
var DX = USER_RAM + 2; // direction: 1 for right/down, 0 for left/up
var DY = USER_RAM + 3;
var COLOR = USER_RAM + 4;

// Buttons, as inp.btn wants them.
var LEFT = 2;
var RIGHT = 3;
var A = 4;

var SCREEN = 128; // the console is 128 x 128, always
var BLOCK = 12;

function boot() {
  sys.poke(X, 58);
  sys.poke(Y, 40);
  sys.poke(DX, 1);
  sys.poke(DY, 1);
  sys.poke(COLOR, 12);
}

function tick() {
  var frame = sys.frame();

  // --- background -----------------------------------------------------------
  gfx.cls(1);

  // A horizon that ripples. sys.sin takes 1024 steps to a full turn and
  // returns 16.16 fixed point, so shifting right by 13 lands the wave in a
  // range of roughly -8 to +8 pixels.
  for (var x = 0; x < SCREEN; x++) {
    var wave = sys.sin(frame * 4 + x * 8) >> 13;
    gfx.rect(x, 88 + wave, 1, SCREEN - (88 + wave), 3, true);
  }

  // --- the block ------------------------------------------------------------
  var bx = sys.peek(X);
  var by = sys.peek(Y);
  var dx = sys.peek(DX);
  var dy = sys.peek(DY);

  // Held buttons steer it; otherwise it drifts and bounces off the edges.
  if (inp.btn(LEFT)) dx = 0;
  if (inp.btn(RIGHT)) dx = 1;

  bx = dx === 1 ? bx + 1 : bx - 1;
  by = dy === 1 ? by + 1 : by - 1;

  if (bx <= 0) {
    bx = 0;
    dx = 1;
  }
  if (bx >= SCREEN - BLOCK) {
    bx = SCREEN - BLOCK;
    dx = 0;
  }
  if (by <= 0) {
    by = 0;
    dy = 1;
  }
  if (by >= 84 - BLOCK) {
    by = 84 - BLOCK;
    dy = 0;
  }

  // A fresh press of A recolours the block. Colours are the 16 live palette
  // slots, 0 to 15.
  var color = sys.peek(COLOR);
  if (inp.btnp(A)) color = color >= 15 ? 1 : color + 1;

  sys.poke(X, bx);
  sys.poke(Y, by);
  sys.poke(DX, dx);
  sys.poke(DY, dy);
  sys.poke(COLOR, color);

  gfx.rect(bx, by, BLOCK, BLOCK, color, true);
  gfx.rect(bx, by, BLOCK, BLOCK, 0, false);

  // --- text -----------------------------------------------------------------
  // gfx.print arrived in a later ABI minor than this cart requires, so it is
  // used only when the player has it. This is the shape of every optional
  // call: ask, then use. A cart that assumed it would refuse to run on a
  // player that is otherwise perfectly capable of running it.
  if (gfx.print) {
    gfx.print("HELLO", 4, 4, 7);
    gfx.print("PRESS A", 4, 12, 6);
  }
}
