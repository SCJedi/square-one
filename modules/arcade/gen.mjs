// `arcade` -- the sixteen colours Red Breaker is played in, and the sixty-four
// cells it is drawn with.
//
//     node modules/arcade/gen.mjs
//
// Run it from the repository root. It prints the sixteen-entry palette line the
// manifest carries, and rewrites modules/arcade/tiles.bin. Regenerating must
// produce identical bytes on any machine -- there is no clock, no randomness
// and no floating point in this file.
//
// WHAT THIS MODULE IS: ONE PACK, TWO THINGS
// -----------------------------------------
// `[module] kind` is still "palette", because a module may sit in exactly one
// recipe slot and `breakout`'s `[requires] palette = true` is the slot this pack
// has to fill. But a pack's `[provides] data` is read by the stamper's `mergeArt`
// WITHOUT REGARD TO KIND -- every layer that names a data file has its cells
// copied to the sheet at `[provides] base` and its flags to SPRITE_FLAGS + base.
// So this one manifest ships the sixteen live slots AND the sixty-four cells,
// and `examples/red-breaker/recipe.toml` needs no new line to get both.
//
// THE SHEET IS modules/FORMATS-breakout-art.md's TABLE, CELL FOR CELL. That file
// owns the layout; this one owns the pixels. Cell `n` is at sheet pixel
// `((n & 15) * 8, (n >> 4) * 8)` and the engine addresses it as `sprite_base + n`.
//
// THE 8 x 6 RULE, WHICH IS THE WHOLE REASON THE OLD SHEET WAS NEVER WIRED IN
// -------------------------------------------------------------------------
// A block is `block_w` x `block_h` = 8 x 6 and a cell is 8 x 8. The engine lifts
// the block out of the TOP of its cell:
//
//     gfx.sspr(cx, cy, 8, 6, x, y)
//
// So CELLS 0..15 DRAW IN ROWS 0..5 AND LEAVE ROWS 6 AND 7 EMPTY. Not centred,
// not "mostly in the top" -- empty, and `assertBlockRows` below refuses to write
// tiles.bin if a single pixel strays into them. Raising `block_h` to 8 instead
// would push the bottom block row to y=105 against a paddle at y=110 and
// collapse the red-block mechanic's reaction space from 28 pixels to 4. Art must
// never cost the game a mechanic.
//
// WHERE THE ART SITS IN EVERY OTHER CELL, because the engine has to know what to
// subtract from an object's position to line the sprite up with its rect:
//
//     TOP-ALIGNED, because the engine draws these at a fixed y --
//     blocks 0..15    rows 0..5 ONLY              lifted 8 x 6 by sspr
//     paddle 16..21   rows 0..2, full 8 wide      (paddle_h = 3)
//     pad    28, 29   rows 0..2, full 8 wide      (pad_zone = 8, paddle_h = 3)
//     beam   25, 26   rows 0..1, full 8 wide      (beam_h = 2), tiles seamlessly
//     break  48..51   from row 0 down             lands on the paddle it destroys
//
//     CENTRED, because the engine centres these on a collision box --
//     ball   22       rows 1..6, cols 1..6        6 x 6 ring, 4 x 4 of white
//     red    23, 24   rows 0..7, cols 0..7        the whole cell. BIGGER ON PURPOSE
//     shot   27       rows 2..5, cols 3..4        2 x 4, plus one row of trail
//     drops  32..43   centred in the cell         6 to 8 wide, outlined
//     spark  52..54   centred in the cell
//
// WHY THE ART IS SOURCE AND THE .bin IS OUTPUT
// -------------------------------------------
// A .bin is unreviewable. A pull request that changes one pixel of the red block
// should read as one changed character, and it does, because the art below is
// one hex digit per pixel: the digit names the ROLE the pixel plays, and REMAP
// turns a role into the live palette slot this pack puts that role on. The
// packing at the bottom is the only part that knows about nibbles.
//
// Writing the art in roles rather than in slot numbers is what let this palette
// be redesigned mid-project without repainting sixty-four cells, and it is what
// would let it be redesigned again. Move a role to a different slot in PALETTE
// and REMAP, and every pixel that meant that role follows.
//
// THE OUTPUT FORMAT
// -----------------
//     bytes 0..2047     pixels: 32 rows of 64 bytes, the console's own sheet
//                       layout -- 128 pixels per row at 4bpp, EVEN x in the LOW
//                       nibble. 4 sheet rows of 16 cells = 64 cells of 8x8.
//     bytes 2048..2111  flags: one byte per cell, in cell order.
//
// THE FIVE DRAWING RULES, which are what works at this size rather than taste.
// modules/FORMATS-breakout-art.md states them; this file keeps them.
//
//   NO DITHERING. A block's face is 6 x 4 pixels. A checker or a 1-pixel hatch
//   in there is not a texture, it is noise, and it eats the silhouette. Every
//   fill below is flat, and the one striped face -- the red block -- uses TWO
//   pixel stripes, which is a stripe rather than a dither.
//
//   SILHOUETTE FIRST. Two things that share an outline must differ in hue. The
//   six drops differ in BOTH: a wide bar, an hourglass, a turret, three balls, a
//   heart and a cup, in green, blue, gold, purple, white and mint.
//
//   ONE LIGHT SOURCE, TOP-LEFT. Every block is a lit row across the top and a
//   lit column down the left, a shaded column down the right and a shaded row
//   along the bottom. Blocks tile edge to edge with no gap between them, so that
//   bevel IS the mortar -- it is what makes forty blocks read as a wall of
//   objects instead of one striped rectangle.
//
//   OUTLINES ON WHAT SITS ON TOP. The ball and the six drops carry a one-pixel
//   dark edge in role `1`, which is the field's own colour: invisible against
//   the field, and a hard edge against a block. Blocks get no outline -- they
//   sit in a grid against a dark field and already have the bevel.
//
//   TWO HUES PER OBJECT, THREE AT MOST. Sixteen slots do not stretch to ramps.
//
// THE ONE RULE THAT MAKES THE SCREEN READ: THE HOT RAMP IS DANGER, AND NOTHING
// ELSE. Roles `d`, `e` and `f` -- danger red, hot orange, dark blood -- appear
// on exactly four things: the type-4 block, the red ball, the beam that saves
// you from it, and the four frames of the paddle being destroyed by it. Those
// are not four decisions; they are one mechanic drawn four times. Every other
// block, the paddle, the drops, the shot and the pads are drawn from the cool
// half. So the first time a player sees red on this screen, red already means
// "this one can kill you", and the red ball is recognisable in the quarter of a
// second the mechanic allows.

import { writeFileSync } from "node:fs";

/**
 * THE SIXTEEN LIVE SLOTS: `entries[i]` is the hardware colour live slot `i`
 * shows. This array IS `[provides] entries` in module.toml; running this file
 * prints the line to paste there, so the palette has one source.
 *
 * THE RULE THE WHOLE TABLE IS BUILT AROUND: SLOTS 11, 12 AND 14 ARE THE ONLY
 * WARM COLOURS ON THE CONSOLE, AND THEY ARE DANGER.
 *
 * Red Breaker's mechanic is that breaking a type-4 block turns the ball red,
 * and the player has ONE CONTACT to get their own paddle out of the way. A
 * palette where anything else on screen is red, orange or pink spends the
 * mechanic's only channel on a power-up icon.
 *
 * So the thirteen slots that are not danger are drawn from the cool half of the
 * hardware palette -- blue, green, purple, gold, and four neutrals -- and the
 * three that are danger are a ramp of one hue: dark blood, danger red, hot
 * orange. Nothing else is allowed in. That is why the `life` drop is white
 * rather than the red heart every instinct asks for: an extra life is the
 * opposite of danger, and it is the one icon that most has to not be red.
 *
 * WHY NOT `sweetie16`. It is a fine cave palette and it is wrong here for a
 * reason that is arithmetic rather than taste. `breakout`'s `drop_color` names
 * the FIRST OF SIX CONSECUTIVE SLOTS, one per drop kind. Against sweetie16 the
 * natural start is slot 8, which puts wide, slow, gun, multi, life and catch on
 * slots 8..13 -- and slot 11 of sweetie16 is its danger red. The `multi`
 * power-up would fall through the field in exactly the colour the ball turns
 * when it is about to kill you. This table starts the drops at slot 2 and puts
 * danger red at 11, which is where `color_red`, `ball_red_color` and
 * `beam_color` already default to.
 *
 *   slot  hw  rgb        role  what it is
 *   ----  --  ---------  ----  --------------------------------------------
 *     0    0  #0d0b12     0    void. The transparent slot.
 *     1    1  #1c1a2b     1    the field, and every outline drawn on top of it.
 *     2   12  #6ec27a     3    green.       WIDE drop, TOUGH block.
 *     3   14  #4a9dd4     5    blue.        SLOW drop, PLAIN block.
 *     4   10  #f7d46b     c    gold.        GUN drop, PRIZE block, the shot.
 *     5   15  #9b6fd4     7    purple.      MULTI drop, HARD block.
 *     6    6  #ffffff     a    white.       LIFE drop, the paddle, the ball.
 *     7   44  #a4d8ab     2    pale mint.   CATCH drop, DRIFTER block.
 *     8   11  #3f7d4e     4    deep green.  A TOUGH block that has taken a hit.
 *     9    3  #6b6486     8    mid slate.   SOLID block, and a spent HARD one.
 *    10    4  #a8a2bd     9    silver.      SHIELDED block, the paddle's shade.
 *    11    8  #d94f5c     d    DANGER RED.  The red block, red ball, the beam.
 *    12    9  #f2934a     e    hot orange.  Danger, bright.
 *    13   13  #2c5f8a     6    deep blue.   Side pads, and the blue's shadow.
 *    14   24  #873139     f    dark blood.  Danger, dark.
 *    15    5  #e8e6f0     b    near-white.  The HUD, a step softer than the ball.
 *
 * Slots 12 and 14 are no longer spare: the red block's stripes are role `f` on
 * role `d`, its pulse frame is role `e`, the red ball's flare is `e` and its
 * outline is `f`. The danger ramp is a ramp now, and it is used only by danger.
 */
const PALETTE = [0, 1, 12, 14, 10, 15, 6, 44, 11, 3, 4, 8, 9, 13, 24, 5];

/**
 * Art role -> live slot. `REMAP[d]` is the slot the pixels written as hex digit
 * `d` come out as.
 *
 * A permutation this time rather than a table with collapses in it: this palette
 * has exactly sixteen useful colours for this game and the art uses all sixteen,
 * so every role is its own slot. The digits are grouped so that a row of art
 * reads: `1` is dark, `2 3 4` is the green ramp, `5 6` the blue, `7 8` the
 * purple, `9 a b` the neutrals, `c` gold -- and `d e f`, the last three digits,
 * are the three danger colours. "The end of the alphabet is the end of you" is
 * the mnemonic, and it means a glance down a cell tells you whether that cell is
 * allowed to be warm.
 */
const REMAP = [0, 1, 7, 2, 8, 3, 13, 5, 9, 10, 6, 15, 4, 11, 12, 14];

/** solid: the ball bounces off it. Every block face carries this. */
const SOLID = 0x01;
/** breakable: a ball or a shot can destroy it. The clear test counts these. */
const BREAKABLE = 0x02;
/** red: breaking it turns the ball RED. */
const RED = 0x04;
/** shield: a ball bounces off; only a shot breaks it. */
const SHIELD = 0x08;
/** drift: its row slides sideways. */
const DRIFT = 0x10;
/** prize: breaking it always drops something. */
const PRIZE = 0x20;

/**
 * The sixty-four cells, in FORMATS-breakout-art.md's order. Eight strings of
 * eight hex digits each; the digit is the ROLE, not the slot.
 */
const TILES = [
  // ==========================================================================
  // ROW 0 -- THE BLOCKS. Eight types, five damage frames, three break frames.
  //
  // ART IN ROWS 0..5 ONLY. Rows 6 and 7 of every cell in this row are empty and
  // `assertBlockRows` enforces it.
  //
  // ONE BEVEL, SHARED BY EVERY TYPE: a lit row across the top, a lit column
  // down the left, a shaded column down the right, a shaded row along the
  // bottom. Blocks are laid 8 pixels apart with no gap, so a block's shaded
  // right column butts straight against its neighbour's lit left column and the
  // wall gets its mortar for free. What changes between types is the HUE and the
  // face motif -- the two things still legible when the block is eight pixels
  // wide and the ball is moving.
  //
  // The interior is 6 x 4. That is the whole budget for a motif, which is why
  // each one is a single idea: a seam, a stud, a crack, a stripe, a gem.
  // ==========================================================================

  // --- 0: type 1 PLAIN -- one hit -------------------------------------------
  // Blue, and a clean face. It is the block every other block is read against,
  // so it is the one that says nothing: no seam, no stud, no crack. Silver rim,
  // deep-blue shadow.
  ["99999999", "95555556", "95555556", "95555556", "95555556", "66666666", "00000000", "00000000"],

  // --- 1: type 2 TOUGH, full health -- two hits ------------------------------
  // Green, with ONE SEAM down the middle: the face is two bricks, and two bricks
  // is two hits. The hit count is drawn rather than remembered.
  ["22222222", "23334334", "23334334", "23334334", "23334334", "44444444", "00000000", "00000000"],

  // --- 2: type 2 TOUGH, one hit taken ---------------------------------------
  // The same green a step darker with the seam gone and a crack in its place.
  // Same hue, same silhouette, visibly worse: a player reads "I hit that one".
  ["33333333", "34441441", "34414441", "34144441", "34414441", "11111111", "00000000", "00000000"],

  // --- 3: type 3 HARD, full health -- three hits -----------------------------
  // Purple, with a silver STUD in the middle: reinforced. The stud is the health
  // meter -- it dulls at one hit and is gone at two.
  ["99999999", "97777778", "97799778", "97799778", "97777778", "88888888", "00000000", "00000000"],

  // --- 4: type 3 HARD, one hit taken -----------------------------------------
  // Stud dulled to slate, one crack through the face. Still bright purple: there
  // are two hits left and it should not yet look nearly dead.
  ["99999999", "97787778", "97788778", "97788778", "97877778", "88888888", "00000000", "00000000"],

  // --- 5: type 3 HARD, two hits taken ----------------------------------------
  // Drained: the body falls to slate -- which is this palette's dark purple, so
  // it is still the same block -- the stud is gone, and a hard X of cracks runs
  // corner to corner. The lit rim stays PURPLE so it cannot be mistaken for the
  // solid block, which is slate all the way through and rimmed in black. The
  // next hit is the last one and it looks like it.
  ["77777777", "71888811", "78188181", "78811881", "78188181", "11111111", "00000000", "00000000"],

  // --- 6: type 4 RED -- one hit, and it turns the ball red -------------------
  // THIS BLOCK HAS TO LOOK DANGEROUS BEFORE ANYONE HAS HIT ONE, and it is the
  // only place on this sheet where two of the three danger colours can be spent
  // at rest. Three things do the work and they are meant to be read in this
  // order: it is the ONLY WARM THING on a screen of blue, green and purple; it
  // is the ONLY STRIPED FACE, and hazard tape is not a pattern anyone has to be
  // taught; and it PULSES against cell 7 while standing still.
  //
  // The stripes are TWO PIXELS wide and run down-right at 45 degrees --
  // `((x - y) & 3) < 2` -- which at 6 x 4 shows two full bands. One-pixel
  // stripes at this size are a dither and would grey the block out to a muddy
  // rose; two-pixel stripes stay stripes.
  ["eeeeeeee", "effddfff", "edffddff", "eddffddf", "efddffdf", "ffffffff", "00000000", "00000000"],

  // --- 7: type 4 RED, the bright pulse frame ---------------------------------
  // THE BODY DOES NOT CHANGE COLOUR, AND THAT IS THE POINT. 6 and 7 are two
  // frames of ONE BLOCK BREATHING, not two blocks; a face that swapped its whole
  // ground colour every other frame would strobe rather than pulse, and a
  // strobing block is a block a player stops looking at.
  //
  // So the bevel, the ground and the geometry are cell 6's, exactly, and only
  // the TAPE moves and lights: the stripes go from blood-dark to hot orange --
  // dark tape becomes bright tape on the same red -- and march two pixels, which
  // in a period-4 pattern lands them on the pixels that were ground a frame ago.
  // The face inverts and slides in one step. It reads as heat travelling through
  // the block, it costs the engine a single `& 1`, and it makes the one block
  // that can kill you the only thing on the screen that moves while standing
  // still.
  ["eeeeeeee", "eddeeddf", "eeddeedf", "eeeddeef", "edeeddef", "ffffffff", "00000000", "00000000"],

  // --- 8: type 5 SOLID -- never breaks ---------------------------------------
  // Deliberately NOT a brick. Where every other block is a raised bevel lit from
  // the top left, this one is a plate RECESSED into a black frame with a bolt in
  // each corner -- no highlight anywhere. Laid in a row the black frames join up
  // into structural lines across the field, which is exactly what it is: part of
  // the room, not part of the wall you are here to clear.
  ["11111111", "19888891", "18888881", "18888881", "19888891", "11111111", "00000000", "00000000"],

  // --- 9: type 6 SHIELDED -- only a shot breaks it ---------------------------
  // Glass over something. A silver frame, a deep-blue pane, and two parallel
  // white glints running up-right across it. Nothing else on the sheet has a
  // glint, and a glint is how a person has always been told a surface is hard
  // and shiny rather than soft and hittable.
  ["99999999", "966a6668", "96a66a68", "9a66a668", "96666668", "88888888", "00000000", "00000000"],

  // --- 10: type 6 SHIELDED, struck by a ball and unhurt ----------------------
  // One frame of flash: the frame goes white, the pane goes bright blue, the
  // glints stay. It reads as "that bounced" rather than "that broke", which is
  // the distinction the player has to make instantly or they will keep aiming a
  // ball at it forever.
  ["aaaaaaaa", "a55a5559", "a5a55a59", "aa55a559", "a5555559", "99999999", "00000000", "00000000"],

  // --- 11: type 7 DRIFTER -- its row slides sideways -------------------------
  // Mint, and the only face on the sheet that says which AXIS it lives on: two
  // arrowheads pointing out to the left and the right. It is the one block whose
  // identity a player can also get from watching it, so the face only has to
  // confirm what the motion says.
  ["bbbbbbbb", "b6622668", "b6222268", "b6222268", "b6622668", "88888888", "00000000", "00000000"],

  // --- 12: type 8 PRIZE -- one hit, and it always drops something ------------
  // A gold brick with a white gem set in it. Gold is this palette's "you want
  // this" colour -- the gun drop, the ammo icon and the charged pad are all gold
  // -- so the block reads as treasure before the gem is even resolved.
  ["bbbbbbbb", "bccaacc8", "bcabbac8", "bcabbac8", "bccaacc8", "88888888", "00000000", "00000000"],

  // --- 13..15: the block breaking, three frames ------------------------------
  // NEUTRAL ON PURPOSE. One animation plays for all eight types, so it cannot
  // carry any type's hue without lying about seven of them. Silver and bone
  // debris against the dark field reads as masonry for every colour of block.
  // 13 -- split into four chunks, still in place.
  ["bbb11bbb", "99911999", "99911999", "11111111", "99911999", "bbb11bbb", "00000000", "00000000"],
  // 14 -- the chunks thrown to the corners, the middle already gone to field.
  ["9b0000b9", "99000099", "00000000", "00000000", "99000099", "9b0000b9", "00000000", "00000000"],
  // 15 -- dust. Four specks and then nothing.
  ["90000009", "00000000", "08000080", "00000000", "00800800", "00000000", "00000000", "00000000"],

  // ==========================================================================
  // ROW 1 -- THE PADDLE, THE BALL, THE BEAM AND THE SHOT
  //
  // A PADDLE IS DRAWN FROM REPEATED CELLS -- left cap, as many middles as it
  // takes, right cap -- so `paddle_w` can be any number of pixels and the art
  // does not have to know. THE ART SITS IN ROWS 0..2, which is `paddle_h = 3`,
  // and the rest of the cell is transparent: the paddle is drawn at its own
  // top-left corner with no offset for the engine to remember.
  // ==========================================================================

  // --- 16..18: the paddle ----------------------------------------------------
  // Three rows and three tones: white along the top, near-white under it, deep
  // blue on the underside. Three pixels of bevel is not much and it is enough --
  // it is the difference between a bar and a bar you can see the top of. The two
  // light tones are a step apart rather than three, on purpose: the paddle has to
  // read as WHITE from across the room, and a mid-grey middle row turned it into
  // a grey bar with a white line on it. The caps are rounded by dropping their
  // outer corner pixels, which is what stops the paddle reading as a slab cut off
  // by the screen edge.
  // 16 left cap
  ["0aaaaaaa", "abbbbbbb", "06666666", "00000000", "00000000", "00000000", "00000000", "00000000"],
  // 17 middle -- repeat for width
  ["aaaaaaaa", "bbbbbbbb", "66666666", "00000000", "00000000", "00000000", "00000000", "00000000"],
  // 18 right cap
  ["aaaaaaa0", "bbbbbbba", "66666660", "00000000", "00000000", "00000000", "00000000", "00000000"],

  // --- 19..21: the paddle with the gun fitted --------------------------------
  // The same paddle with GOLD MUZZLES at the two ends and gold studs along the
  // middle. Gold is the shot's own colour, so "the paddle is armed" and "that
  // bolt came from me" are one colour, and a player who has caught the gun drop
  // never has to check whether it is still running.
  // 19 gun, left cap
  ["0ccaaaaa", "accbbbbb", "06666666", "00000000", "00000000", "00000000", "00000000", "00000000"],
  // 20 gun, middle
  ["aaaaaaaa", "bbcbbcbb", "66666666", "00000000", "00000000", "00000000", "00000000", "00000000"],
  // 21 gun, right cap
  ["aaaaacc0", "bbbbbcca", "66666660", "00000000", "00000000", "00000000", "00000000", "00000000"],

  // --- 22: the ball ----------------------------------------------------------
  // FOUR PIXELS ACROSS WITH THE CORNERS KNOCKED OFF, which is the whole trick: a
  // flat 4 x 4 of white reads as a small white BRICK, and this game already has
  // forty of those. Cutting the four corners costs four pixels and turns it into
  // a ball.
  //
  // It is ringed in role `1`, the field's own colour, so the ring is invisible
  // against the field and cuts the ball cleanly out of any block it crosses --
  // one pixel of outline doing a drop shadow's work for free. Lit white at the
  // top left, bone at the bottom right, and nothing else: two hues.
  //
  // Small on purpose. The red ball has to be the bigger of the two by enough to
  // see in peripheral vision, and the cheapest way to buy that is to keep this
  // one honest at the size of its own collision box.
  ["00000000", "00011000", "001aa100", "01aaaa10", "01aabb10", "001bb100", "00011000", "00000000"],

  // --- 23..24: THE RED BALL, two frames --------------------------------------
  // THE PLAYER HAS UNDER A SECOND. So this is not a recolour of cell 22 -- a
  // recolour asks the eye to compare hues, and the eye compares SHAPES faster.
  // Four differences stack, and any one of them alone would be enough:
  //
  //   BIGGER      8 x 8 against the white ball's 6 x 6.
  //   ROUNDER     an octagon, where the white ball is a small square with the
  //               corners knocked off.
  //   CORED       a hot orange centre the white ball has no equivalent of.
  //   FLARING     frame B throws four orange spikes off the corners and lights
  //               its edges; frames A and B alternate, so the thing pulses.
  //
  // Blood-dark rims it, which reads as an outline at speed and as a shadow at
  // rest. It is the only sprite in the game that is bigger than the thing it
  // replaces, and that alone is visible in peripheral vision.
  // 23 frame A -- the octagon, banked down
  ["000ff000", "00fddf00", "0fddddf0", "fddeeddf", "fddeeddf", "0fddddf0", "00fddf00", "000ff000"],
  // 24 frame B -- flared: the rim lights and four spikes come off the corners
  ["000ee000", "e0fddf0e", "0fddddf0", "eddeedde", "eddeedde", "0fddddf0", "e0fddf0e", "000ee000"],

  // --- 25..26: the beam ------------------------------------------------------
  // Drawn below the paddle and only while a ball is RED, which is why it is
  // allowed the hot ramp: it is the same mechanic seen from the other side.
  // TWO ROWS, because `beam_h` is 2, and IT TILES ACROSS THE SCREEN -- both
  // frames are 8 wide with period 4, so butting them together at any multiple of
  // eight leaves no seam. Frame B is frame A's dashes marched two pixels, so the
  // beam scrolls and reads as live rather than painted.
  // 25 frame A
  ["eeddeedd", "dddddddd", "00000000", "00000000", "00000000", "00000000", "00000000", "00000000"],
  // 26 frame B
  ["ddeeddee", "dddddddd", "00000000", "00000000", "00000000", "00000000", "00000000", "00000000"],

  // --- 27: the shot in flight ------------------------------------------------
  // Two wide and four tall, centred in the cell, with a white tip so the leading
  // edge is the brightest thing about it, and one slate row of trail below.
  ["00000000", "00000000", "000aa000", "000cc000", "000cc000", "000cc000", "00088000", "00000000"],

  // --- 28..29: the side charge pads ------------------------------------------
  // Eight wide by three tall, in the top rows like the paddle, and SYMMETRIC
  // LEFT TO RIGHT so one cell serves both walls -- the console cannot flip a
  // sprite and a second cell for the mirror image would be a second thing to
  // keep in step. Idle is deep blue, the one hue nothing else on the screen
  // uses. Charged is gold and much brighter, because "I have a shot" has to be
  // answerable from peripheral vision.
  // 28 idle -- a deep-blue plate with a silver bolt at each corner. The bolts
  //    are there because deep blue on the dark field is nearly the field: a pad
  //    is a place a player has to NOTICE before anyone has told them what it
  //    does, and four bright pixels are what buy that without spending a hue.
  ["96666669", "66666666", "96666669", "00000000", "00000000", "00000000", "00000000", "00000000"],
  // 29 charged
  ["6cc66cc6", "cccccccc", "6cc66cc6", "00000000", "00000000", "00000000", "00000000", "00000000"],

  // --- 30..31: spare, filled with the two HUD glyphs -------------------------
  // The format calls these spare. A life is drawn as a paddle because a paddle
  // is what you lose, and a shot in hand as the bolt itself; both are one cell,
  // both cost nothing, and an engine that does not want them simply never names
  // them.
  // 30 a life
  ["00000000", "0aaaaaa0", "0bbbbbb0", "06666660", "00000000", "00000000", "00000000", "00000000"],
  // 31 a shot in hand
  ["00000000", "000aa000", "000cc000", "000cc000", "000cc000", "00088000", "00000000", "00000000"],

  // ==========================================================================
  // ROW 2 -- THE SIX DROPS, two frames each so they tumble.
  //
  // SIX SHAPES AND SIX HUES, not six capsules with six letters in them. A drop
  // is on screen for about a second while the player is already tracking a ball,
  // so it has to be identifiable from its OUTLINE at the edge of vision: a wide
  // bar, an hourglass, a bullet, three balls, a heart, a cup. Every one is
  // outlined in role `1` -- the field's own colour -- so it cuts cleanly out of
  // any block it falls past and disappears into the field behind it.
  //
  // Frame B is frame A narrowed or rearranged, which is the cheapest honest
  // tumble: at 8 pixels a rotation is a lie, and a squash is not.
  //
  // The order is DROP_MASK's bit order, so a drop kind is also an offset from
  // cell 32: wide, slow, gun, multi, life, catch.
  // ==========================================================================

  // --- 32..33: WIDE, green ---------------------------------------------------
  // The widest and flattest thing in the row, which is the whole joke: the drop
  // that makes the paddle wider is the one shaped like a wider paddle. Four rows
  // in an eight-row cell, so it centres exactly on its collision box.
  ["00000000", "00000000", "22222222", "33333333", "33333333", "11111111", "00000000", "00000000"],
  ["00000000", "00000000", "02222220", "03333330", "03333330", "01111110", "00000000", "00000000"],

  // --- 34..35: SLOW, blue ----------------------------------------------------
  // An hourglass: silver caps, blue sand, pinched in the middle. The only drop
  // that is taller than it is wide, so it is separable from the others by
  // proportion before colour or detail.
  ["01111110", "19999991", "01555510", "00155100", "00155100", "01555510", "19999991", "01111110"],
  ["00111100", "01999910", "01555510", "00155100", "00155100", "01555510", "01999910", "00111100"],

  // --- 36..37: GUN, gold -----------------------------------------------------
  // A turret seen from the side: a two-pixel barrel standing on a six-pixel
  // base, widening in three steps. A shape that is narrow at the top and wide at
  // the bottom has a DIRECTION, and the direction is where the shots go. It went
  // through a rocket with fins first, which at eight pixels read as a capital A.
  // Gold, like the shot it gives you and the pad that charges it.
  ["00000000", "001cc100", "001cc100", "01cccc10", "1cbcccc1", "1cccccc1", "01111110", "00000000"],
  ["00000000", "001cc100", "001cc100", "001cc100", "01cccc10", "01cccc10", "00111100", "00000000"],

  // --- 38..39: MULTI, purple -------------------------------------------------
  // One ball becoming three, drawn as three balls -- the icon is a picture of
  // the outcome rather than a symbol for it. Frame B flips the triangle, which
  // is a tumble a group of balls can plausibly do.
  ["00000000", "000bb000", "00077100", "00011000", "0bb00bb0", "07710771", "01100110", "00000000"],
  ["00000000", "0bb00bb0", "07710771", "01100110", "000bb000", "00077100", "00011000", "00000000"],

  // --- 40..41: LIFE, white ---------------------------------------------------
  // THE ONE A PLAYER MOST WANTS TO RECOGNISE MID-FALL, so it is the only drop
  // that is not a machine part: a heart, and the only heart-shaped thing in the
  // game. It is WHITE and not red, and that is the palette's hardest rule paying
  // out -- an extra life is the opposite of danger and is the one icon that most
  // has to not be red. White also makes it the brightest drop on a dark field,
  // which is the second half of recognising it early.
  //
  // Frame B does not tumble. A silhouette this valuable should not deform, so it
  // brightens instead: the shading flushes out and four sparks come off the
  // corners. It reads as a heart that is SHINING rather than one that is
  // spinning, and it stays exactly as recognisable in both frames.
  ["00000000", "01100110", "1aa11aa1", "1aaaabb1", "01aabb10", "001bb100", "00011000", "00000000"],
  ["00000000", "b110011b", "1aa11aa1", "1aaaaaa1", "01aaaa10", "b01aa10b", "00011000", "00000000"],

  // --- 42..43: CATCH, mint ---------------------------------------------------
  // A ball resting in a cup. The two frames are not a tumble but the ACTION: in
  // frame A the ball is above the cup, in frame B it has settled into it, so the
  // icon demonstrates the power-up while it falls.
  ["00000000", "000aa000", "000bb000", "02000020", "02000020", "02222220", "01111110", "00000000"],
  ["00000000", "00000000", "00000000", "020aa020", "020bb020", "02222220", "01111110", "00000000"],

  // --- 44..47: spare ---------------------------------------------------------
  // The format reserves four cells here for a seventh drop kind. Left empty
  // rather than filled with something an engine might draw by accident.
  ["00000000", "00000000", "00000000", "00000000", "00000000", "00000000", "00000000", "00000000"],
  ["00000000", "00000000", "00000000", "00000000", "00000000", "00000000", "00000000", "00000000"],
  ["00000000", "00000000", "00000000", "00000000", "00000000", "00000000", "00000000", "00000000"],
  ["00000000", "00000000", "00000000", "00000000", "00000000", "00000000", "00000000", "00000000"],

  // ==========================================================================
  // ROW 3 -- THE EFFECTS
  // ==========================================================================

  // --- 48..51: THE PADDLE DESTROYED, four frames -----------------------------
  // THIS IS WHAT A RED BALL DOES TO YOU AND IT SHOULD HURT TO WATCH.
  //
  // The sequence is built as a demolition rather than a puff of smoke, and it
  // starts on the paddle's own three rows so frame one lands exactly where the
  // paddle was -- the player sees THEIR paddle catch, not an explosion drawn
  // over it. Then it comes apart downward and the last frame is embers falling
  // into the gutter the ball just went out of.
  //
  //   48  white-hot. BOTH of the paddle's lit rows blow out to pure white and
  //       the third goes orange -- brighter than the paddle has ever been, in
  //       the frame it stops existing -- with the first red spray under it.
  //   49  the bar splits. Gaps open, the glow drops through them.
  //   50  fragments, thrown apart and already falling.
  //   51  embers. Blood-dark, sparse, going down and out.
  //
  // Every cell is left-to-right symmetric so it can be tiled across a paddle of
  // any width and still look like one event.
  ["aaaaaaaa", "aaaaaaaa", "eeeeeeee", "dd0dd0dd", "0f0000f0", "00000000", "00000000", "00000000"],
  ["aa0aa0aa", "ee0ee0ee", "d0dd0dd0", "0f00f00f", "00f00f00", "00000000", "00000000", "00000000"],
  ["a00a00a0", "0e00e00e", "00d00d00", "d00ff00d", "0f0000f0", "00f00f00", "00000000", "00000000"],
  ["00000000", "0d0000d0", "00000000", "00f00f00", "0000d000", "00f00000", "0d0000f0", "0000f000"],

  // --- 52..54: the ball's impact spark, three frames -------------------------
  // Neutral, like the block-break frames and for the same reason: it fires
  // against every colour of block and against the walls. Tight and bright, then
  // a ring, then four dim specks.
  ["00000000", "00000000", "000bb000", "00baab00", "00baab00", "000bb000", "00000000", "00000000"],
  ["00000000", "000bb000", "00b00b00", "b000000b", "b000000b", "00b00b00", "000bb000", "00000000"],
  ["00000000", "08000080", "00000000", "80000008", "80000008", "00000000", "08000080", "00000000"],

  // --- 55: the ball trail, WHICH THE ENGINE DOES NOT DRAW --------------------
  // The format reserves a cell for it and `breakout` does not use one: keeping a
  // trail means keeping trail state, and the tokens that would cost were spent
  // on the red-ball mechanic instead. Left empty on purpose rather than drawn
  // and unreachable -- a cell with art in it that nothing blits is a thing a
  // later reader has to disprove.
  ["00000000", "00000000", "00000000", "00000000", "00000000", "00000000", "00000000", "00000000"],

  // --- 56..63: spare ---------------------------------------------------------
  // Eight cells of room to grow, left empty.
  ["00000000", "00000000", "00000000", "00000000", "00000000", "00000000", "00000000", "00000000"],
  ["00000000", "00000000", "00000000", "00000000", "00000000", "00000000", "00000000", "00000000"],
  ["00000000", "00000000", "00000000", "00000000", "00000000", "00000000", "00000000", "00000000"],
  ["00000000", "00000000", "00000000", "00000000", "00000000", "00000000", "00000000", "00000000"],
  ["00000000", "00000000", "00000000", "00000000", "00000000", "00000000", "00000000", "00000000"],
  ["00000000", "00000000", "00000000", "00000000", "00000000", "00000000", "00000000", "00000000"],
  ["00000000", "00000000", "00000000", "00000000", "00000000", "00000000", "00000000", "00000000"],
  ["00000000", "00000000", "00000000", "00000000", "00000000", "00000000", "00000000", "00000000"],
];

/**
 * What each cell IS, as SPRITE_FLAGS bits. Only the thirteen block faces carry
 * any: everything else on this sheet is a sprite the engine places by hand, and
 * a flag on a drop icon would be a claim nothing reads.
 *
 * `[provides] flags` in module.toml declares these six names and their bits, and
 * the stamper now opens tiles.bin and refuses a name no cell carries -- so this
 * block of code and that block of manifest are checked against each other at
 * every build.
 */
const FLAGS = new Uint8Array(64);
/** Cells 0..12 are the block faces and their damage frames. A ball bounces off all of them. */
for (const n of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) FLAGS[n] = SOLID;
/** The clear test counts these: every type but 5, which is structure. */
for (const n of [0, 1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12]) FLAGS[n] |= BREAKABLE;
/** Type 4 and its pulse frame: breaking one turns the ball red. */
FLAGS[6] |= RED;
FLAGS[7] |= RED;
/** Type 6 and its flash frame: a ball bounces, only a shot breaks it. */
FLAGS[9] |= SHIELD;
FLAGS[10] |= SHIELD;
/** Type 7: its row slides. */
FLAGS[11] |= DRIFT;
/** Type 8: it always drops something. */
FLAGS[12] |= PRIZE;

/** Sheet bytes per pixel row: 128 pixels at two per byte. */
const STRIDE = 64;
/** Sheet cells across. */
const COLS = 16;
/** Cells whose art must fit in the top 6 rows, because the engine `sspr`s 8 x 6 out of them. */
const BLOCK_CELLS = 16;
/** A block's drawn height. `block_h` in breakout's manifest, and not a coincidence. */
const BLOCK_H = 6;

/**
 * THE CHECK THAT MATTERS MOST IN THIS FILE.
 *
 * The engine lifts `8 x BLOCK_H` out of the top of a block cell. A pixel drawn
 * below that is not clipped, not warned about and not visible -- it is simply
 * absent from the game, and the failure looks exactly like a mistake in the
 * art. So the generator refuses to write the file instead.
 */
function assertBlockRows(tiles) {
  for (let n = 0; n < BLOCK_CELLS; n++) {
    const art = tiles[n];
    for (let r = BLOCK_H; r < 8; r++) {
      const line = art[r];
      if (line !== "00000000") {
        throw new Error(
          `cell ${n} row ${r} is "${line}": cells 0..${BLOCK_CELLS - 1} are drawn with ` +
            `sspr(cx, cy, 8, ${BLOCK_H}, x, y) and rows ${BLOCK_H}..7 are never drawn. ` +
            `Move the art up; do not centre it.`,
        );
      }
    }
  }
}

if (TILES.length !== 64) throw new Error(`${TILES.length} cells, expected 64`);
assertBlockRows(TILES);

const rows = Math.ceil(TILES.length / COLS) * 8;
const pixels = new Uint8Array(rows * STRIDE);

for (let n = 0; n < TILES.length; n++) {
  const art = TILES[n];
  if (art.length !== 8) throw new Error(`cell ${n}: ${art.length} rows, expected 8`);
  const ox = (n % COLS) * 8;
  const oy = Math.floor(n / COLS) * 8;
  for (let r = 0; r < 8; r++) {
    const line = art[r];
    if (line.length !== 8) throw new Error(`cell ${n} row ${r}: "${line}" is not 8 characters`);
    for (let c = 0; c < 8; c++) {
      const role = parseInt(line[c], 16);
      if (Number.isNaN(role)) throw new Error(`cell ${n} row ${r}: "${line[c]}" is not a hex digit`);
      const v = REMAP[role];
      const px = ox + c;
      const i = (oy + r) * STRIDE + (px >> 1);
      pixels[i] = (px & 1) === 0 ? (pixels[i] & 0xf0) | v : (pixels[i] & 0x0f) | (v << 4);
    }
  }
}

const out = new Uint8Array(pixels.length + FLAGS.length);
out.set(pixels, 0);
out.set(FLAGS, pixels.length);

if (PALETTE.length !== 16) throw new Error(`PALETTE has ${PALETTE.length} entries, expected 16`);
for (const e of PALETTE) {
  if (!Number.isInteger(e) || e < 0 || e > 63) throw new Error(`hardware colour ${e} is not 0..63`);
}
if (REMAP.length !== 16) throw new Error(`REMAP has ${REMAP.length} entries, expected 16`);
for (const s of REMAP) {
  if (!Number.isInteger(s) || s < 0 || s > 15) throw new Error(`live slot ${s} is not 0..15`);
}
{
  // Every role is its own slot, so a lost role would be a silently recoloured
  // sheet rather than an error. Sixteen distinct values is the whole test.
  const seen = new Set(REMAP);
  if (seen.size !== 16) throw new Error(`REMAP is not a permutation: ${seen.size} distinct slots`);
}

writeFileSync(new URL("./tiles.bin", import.meta.url), out);
console.log(`entries = [${PALETTE.join(", ")}]`);
console.log(
  `arcade: 16 palette entries; ${TILES.length} cells drawn, ` +
    `${pixels.length} bytes of pixels + ${FLAGS.length} flags = ${out.length} bytes`,
);
