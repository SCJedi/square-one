// Derivation. Rule R2: keywords are NOT discounted. Each one costs one token,
// exactly like an identifier or a punctuator.
//
//   if (a) { b; } else { c; }
//     [if][(][a][)][{][b][;][}][else][{][c][;][}]                      = 13
//   for (const k of ks) { d(k); }
//     [for][(][const][k][of][ks][)][{][d][(][k][)][;][}]               = 14
//   while (x) { break; }
//     [while][(][x][)][{][break][;][}]                                 =  8
//   do { y(); } while (z);
//     [do][{][y][(][)][;][}][while][(][z][)][;]                        = 12
//   switch (n) { case 1: break; default: break; }
//     [switch][(][n][)][{][case][1][:][break][;][default][:][break][;][}]
//                                                                      = 15
//   try { f(); } catch (e) { g(e); } finally { h(); }
//     [try][{][f][(][)][;][}][catch][(][e][)][{][g][(][e][)][;][}]
//     [finally][{][h][(][)][;][}]                                      = 25
//   typeof a; void 0; delete o.p; new C(); a instanceof B; 'k' in o;
//     [typeof][a][;][void][0][;][delete][o][.][p][;][new][C][(][)][;]
//     [a][instanceof][B][;]['k'][in][o][;]                             = 24
//
// Total: 13 + 14 + 8 + 12 + 15 + 25 + 24 = 111.
if (a) { b; } else { c; }
for (const k of ks) { d(k); }
while (x) { break; }
do { y(); } while (z);
switch (n) { case 1: break; default: break; }
try { f(); } catch (e) { g(e); } finally { h(); }
typeof a; void 0; delete o.p; new C(); a instanceof B; 'k' in o;
