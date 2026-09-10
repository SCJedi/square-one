// Derivation: 7 string statements, each one string token plus one `;` token.
// The fifth is a single string spread over two lines by a line continuation,
// which is still exactly one token. 7 x 2 = 14.
'plain';
"double";
'it\'s';
"tab\tsep\nnl";
'line\
continued';
"A\x42";
'';
