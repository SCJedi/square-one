// Derivation. This fixture PINS the three places where the previous-token
// regex-versus-division heuristic (rule R7) is knowingly wrong. These counts
// are normative: a second implementation must reproduce them, which is easy
// precisely because the rule never looks at more than one previous token.
//
//   if (a) {} /x/g;
//     `}` is always treated as ending an expression, so the `/` is division.
//     A real parser sees a regex here (7 tokens). We count:
//     [if][(][a][)][{][}][/][x][/][g][;]                               = 11
//
//   if (a) /b/.test(c);
//     `)` is always treated as ending an expression, so the `/` is division.
//     A real parser sees a regex here (10 tokens). We count:
//     [if][(][a][)][/][b][/][.][test][(][c][)][;]                      = 13
//
//   export default /a/g;
//     `default` IS in the regex-allowing keyword set, so this is right:
//     [export][default][/a/g][;]                                       =  4
//
//   of / 2 / 3;
//     `of` is unconditionally a keyword that allows a regex, so a variable
//     named `of` followed by division mis-lexes. A real parser sees six
//     tokens. We count [of] [/ 2 /] [3] [;]                            =  4
//
// Total: 32.
if (a) {} /x/g;
if (a) /b/.test(c);
export default /a/g;
of / 2 / 3;
