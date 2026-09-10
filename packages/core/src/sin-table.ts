// GENERATED FILE -- DO NOT EDIT BY HAND.
//
// Produced by packages/core/tools/gen-sin.ts. Regenerate with:
//     npm run gen:sin
//
// The normative copy of these values is conformance/fixtures/sin1024.bin; this
// module exists only because packages/core does zero file I/O (it has to run in
// a browser worker). test/sin.test.ts asserts the two agree, and that
// regenerating reproduces both byte for byte.
//
// 1024 entries of 16.16 fixed point: sin(2*pi*i/1024) * 65536, rounded half
// away from zero. Stored as base64 of 1024 little-endian int32.

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const PACKED =
  "AAAAAJIBAAAkAwAAtgQAAEgGAADaBwAAbAkAAP4KAACQDAAAIQ4AALMPAABEEQAA1RIAAGYUAAD3" +
  "FQAAhxcAABgZAACoGgAAOBwAAMcdAABWHwAA5SAAAHQiAAACJAAAkCUAAB4nAACrKAAAOCoAAMQr" +
  "AABQLQAA3C4AAGcwAADxMQAAfDMAAAU1AACONgAAFzgAAJ85AAAnOwAArjwAADQ+AAC6PwAAP0EA" +
  "AMNCAABHRAAAy0UAAE1HAADPSAAAUEoAANFLAABQTQAAz04AAE1QAADLUQAASFMAAMNUAAA+VgAA" +
  "uVcAADJZAACqWgAAIlwAAJldAAAPXwAAhGAAAPhhAABrYwAA3WQAAE5mAAC+ZwAALWkAAJtqAAAI" +
  "bAAAdG0AAN9uAABJcAAAsnEAABpzAACAdAAA5nUAAEp3AACteAAAEHoAAHB7AADQfAAAL34AAIx/" +
  "AADogAAAQ4IAAJyDAAD1hAAATIYAAKGHAAD2iAAASYoAAJqLAADrjAAAOo4AAIiPAADUkAAAH5IA" +
  "AGiTAACwlAAA95UAADyXAACAmAAAwpkAAAObAABCnAAAgJ0AALyeAAD3nwAAMKEAAGiiAACeowAA" +
  "0qQAAAWmAAA2pwAAZqgAAJSpAADBqgAA66sAABStAAA8rgAAYq8AAIawAACosQAAybIAAOizAAAF" +
  "tQAAILYAADq3AABSuAAAaLkAAH26AACPuwAAoLwAAK+9AAC8vgAAx78AANHAAADYwQAA3sIAAOLD" +
  "AADkxAAA5MUAAOLGAADexwAA2cgAANHJAADHygAAvMsAAK7MAACfzQAAjs4AAHrPAABl0AAATdEA" +
  "ADTSAAAY0wAA+9MAANvUAAC61QAAltYAAHDXAABI2AAAHtkAAPLZAADE2gAAlNsAAGLcAAAt3QAA" +
  "990AAL7eAACD3wAARuAAAAfhAADG4QAAguIAADzjAAD04wAAquQAAF7lAAAQ5gAAv+YAAGznAAAX" +
  "6AAAv+gAAGbpAAAK6gAAq+oAAEvrAADo6wAAg+wAABztAACz7QAAR+4AANnuAABo7wAA9e8AAIDw" +
  "AAAJ8QAAj/EAABPyAACV8gAAFPMAAJHzAAAM9AAAhPQAAPr0AABu9QAA3/UAAE72AAC69gAAJPcA" +
  "AIz3AADx9wAAVPgAALT4AAAT+QAAbvkAAMj5AAAf+gAAc/oAAMX6AAAV+wAAYvsAAK37AAD1+wAA" +
  "O/wAAH/8AADA/AAA/vwAADv9AAB0/QAArP0AAOH9AAAT/gAAQ/4AAHH+AACc/gAAxP4AAOv+AAAO" +
  "/wAAMP8AAE7/AABr/wAAhf8AAJz/AACx/wAAxP8AANT/AADh/wAA7P8AAPX/AAD7/wAA//8AAAAA" +
  "AQD//wAA+/8AAPX/AADs/wAA4f8AANT/AADE/wAAsf8AAJz/AACF/wAAa/8AAE7/AAAw/wAADv8A" +
  "AOv+AADE/gAAnP4AAHH+AABD/gAAE/4AAOH9AACs/QAAdP0AADv9AAD+/AAAwPwAAH/8AAA7/AAA" +
  "9fsAAK37AABi+wAAFfsAAMX6AABz+gAAH/oAAMj5AABu+QAAE/kAALT4AABU+AAA8fcAAIz3AAAk" +
  "9wAAuvYAAE72AADf9QAAbvUAAPr0AACE9AAADPQAAJHzAAAU8wAAlfIAABPyAACP8QAACfEAAIDw" +
  "AAD17wAAaO8AANnuAABH7gAAs+0AABztAACD7AAA6OsAAEvrAACr6gAACuoAAGbpAAC/6AAAF+gA" +
  "AGznAAC/5gAAEOYAAF7lAACq5AAA9OMAADzjAACC4gAAxuEAAAfhAABG4AAAg98AAL7eAAD33QAA" +
  "Ld0AAGLcAACU2wAAxNoAAPLZAAAe2QAASNgAAHDXAACW1gAAutUAANvUAAD70wAAGNMAADTSAABN" +
  "0QAAZdAAAHrPAACOzgAAn80AAK7MAAC8ywAAx8oAANHJAADZyAAA3scAAOLGAADkxQAA5MQAAOLD" +
  "AADewgAA2MEAANHAAADHvwAAvL4AAK+9AACgvAAAj7sAAH26AABouQAAUrgAADq3AAAgtgAABbUA" +
  "AOizAADJsgAAqLEAAIawAABirwAAPK4AABStAADrqwAAwaoAAJSpAABmqAAANqcAAAWmAADSpAAA" +
  "nqMAAGiiAAAwoQAA958AALyeAACAnQAAQpwAAAObAADCmQAAgJgAADyXAAD3lQAAsJQAAGiTAAAf" +
  "kgAA1JAAAIiPAAA6jgAA64wAAJqLAABJigAA9ogAAKGHAABMhgAA9YQAAJyDAABDggAA6IAAAIx/" +
  "AAAvfgAA0HwAAHB7AAAQegAArXgAAEp3AADmdQAAgHQAABpzAACycQAASXAAAN9uAAB0bQAACGwA" +
  "AJtqAAAtaQAAvmcAAE5mAADdZAAAa2MAAPhhAACEYAAAD18AAJldAAAiXAAAqloAADJZAAC5VwAA" +
  "PlYAAMNUAABIUwAAy1EAAE1QAADPTgAAUE0AANFLAABQSgAAz0gAAE1HAADLRQAAR0QAAMNCAAA/" +
  "QQAAuj8AADQ+AACuPAAAJzsAAJ85AAAXOAAAjjYAAAU1AAB8MwAA8TEAAGcwAADcLgAAUC0AAMQr" +
  "AAA4KgAAqygAAB4nAACQJQAAAiQAAHQiAADlIAAAVh8AAMcdAAA4HAAAqBoAABgZAACHFwAA9xUA" +
  "AGYUAADVEgAARBEAALMPAAAhDgAAkAwAAP4KAABsCQAA2gcAAEgGAAC2BAAAJAMAAJIBAAAAAAAA" +
  "bv7//9z8//9K+///uPn//yb4//+U9v//AvX//3Dz///f8f//TfD//7zu//8r7f//muv//wnq//95" +
  "6P//6Ob//1jl///I4///OeL//6rg//8b3///jN3///7b//9w2v//4tj//1XX///I1f//PNT//7DS" +
  "//8k0f//mc///w/O//+EzP//+8r//3LJ///px///Ycb//9nE//9Sw///zMH//0bA///Bvv//Pb3/" +
  "/7m7//81uv//s7j//zG3//+wtf//L7T//7Cy//8xsf//s6///zWu//+4rP//Pav//8Kp//9HqP//" +
  "zqb//1al///eo///Z6L///Gg//98n///CJ7//5Wc//8jm///spn//0KY///Tlv//ZZX///iT//+M" +
  "kv//IZH//7eP//9Ojv//5oz//4CL//8aiv//toj//1OH///whf//kIT//zCD///Rgf//dID//xh/" +
  "//+9ff//ZHz//wt7//+0ef//X3j//wp3//+3df//ZnT//xVz///Gcf//eHD//yxv///hbf//mGz/" +
  "/1Br//8Jav//xGj//4Bn//8+Zv///WT//75j//+AYv//RGH//wlg///QXv//mF3//2Jc//8uW///" +
  "+1n//8pY//+aV///bFb//z9V//8VVP//7FL//8RR//+eUP//ek///1hO//83Tf//GEz///tK///g" +
  "Sf//xkj//65H//+YRv//g0X//3FE//9gQ///UUL//0RB//85QP//Lz///yg+//8iPf//Hjz//xw7" +
  "//8cOv//Hjn//yI4//8nN///Lzb//zk1//9ENP//UjP//2Ey//9yMf//hjD//5sv//+zLv//zC3/" +
  "/+gs//8FLP//JSv//0Yq//9qKf//kCj//7gn///iJv//Dib//zwl//9sJP//niP//9Mi//8JIv//" +
  "QiH//30g//+6H///+R7//zoe//9+Hf//xBz//wwc//9WG///ohr///AZ//9BGf//lBj//+kX//9B" +
  "F///mhb///YV//9VFf//tRT//xgU//99E///5BL//00S//+5Ef//JxH//5gQ//8LEP//gA////cO" +
  "//9xDv//7Q3//2sN///sDP//bwz///QL//98C///Bgv//5IK//8hCv//sgn//0YJ///cCP//dAj/" +
  "/w8I//+sB///TAf//+0G//+SBv//OAb//+EF//+NBf//OwX//+sE//+eBP//UwT//wsE///FA///" +
  "gQP//0AD//8CA///xQL//4wC//9UAv//HwL//+0B//+9Af//jwH//2QB//88Af//FQH///IA///Q" +
  "AP//sgD//5UA//97AP//ZAD//08A//88AP//LAD//x8A//8UAP//CwD//wUA//8BAP//AAD//wEA" +
  "//8FAP//CwD//xQA//8fAP//LAD//zwA//9PAP//ZAD//3sA//+VAP//sgD//9AA///yAP//FQH/" +
  "/zwB//9kAf//jwH//70B///tAf//HwL//1QC//+MAv//xQL//wID//9AA///gQP//8UD//8LBP//" +
  "UwT//54E///rBP//OwX//40F///hBf//OAb//5IG///tBv//TAf//6wH//8PCP//dAj//9wI//9G" +
  "Cf//sgn//yEK//+SCv//Bgv//3wL///0C///bwz//+wM//9rDf//7Q3//3EO///3Dv//gA///wsQ" +
  "//+YEP//JxH//7kR//9NEv//5BL//30T//8YFP//tRT//1UV///2Ff//mhb//0EX///pF///lBj/" +
  "/0EZ///wGf//ohr//1Yb//8MHP//xBz//34d//86Hv//+R7//7of//99IP//QiH//wki///TIv//" +
  "niP//2wk//88Jf//Dib//+Im//+4J///kCj//2op//9GKv//JSv//wUs///oLP//zC3//7Mu//+b" +
  "L///hjD//3Ix//9hMv//UjP//0Q0//85Nf//Lzb//yc3//8iOP//Hjn//xw6//8cO///Hjz//yI9" +
  "//8oPv//Lz///zlA//9EQf//UUL//2BD//9xRP//g0X//5hG//+uR///xkj//+BJ///7Sv//GEz/" +
  "/zdN//9YTv//ek///55Q///EUf//7FL//xVU//8/Vf//bFb//5pX///KWP//+1n//y5b//9iXP//" +
  "mF3//9Be//8JYP//RGH//4Bi//++Y////WT//z5m//+AZ///xGj//wlq//9Qa///mGz//+Ft//8s" +
  "b///eHD//8Zx//8Vc///ZnT//7d1//8Kd///X3j//7R5//8Le///ZHz//719//8Yf///dID//9GB" +
  "//8wg///kIT///CF//9Th///toj//xqK//+Ai///5oz//06O//+3j///IZH//4yS///4k///ZZX/" +
  "/9OW//9CmP//spn//yOb//+VnP//CJ7//3yf///xoP//Z6L//96j//9Wpf//zqb//0eo///Cqf//" +
  "Pav//7is//81rv//s6///zGx//+wsv//L7T//7C1//8xt///s7j//zW6//+5u///Pb3//8G+//9G" +
  "wP//zMH//1LD///ZxP//Ycb//+nH//9yyf//+8r//4TM//8Pzv//mc///yTR//+w0v//PNT//8jV" +
  "//9V1///4tj//3Da///+2///jN3//xvf//+q4P//OeL//8jj//9Y5f//6Ob//3no//8J6v//muv/" +
  "/yvt//+87v//TfD//9/x//9w8///AvX//5T2//8m+P//uPn//0r7///c/P//bv7//w==";

/**
 * Decode base64 to int32 without atob or Buffer, so this module depends on
 * nothing but the language itself and loads identically in a worker, in Node
 * and in a test runner.
 */
function unpack(s: string): Int32Array {
  const lut = new Uint8Array(128);
  for (let i = 0; i < B64.length; i++) lut[B64.charCodeAt(i)] = i;

  let len = s.length;
  while (len > 0 && s.charCodeAt(len - 1) === 61 /* '=' */) len--;

  const byteLen = (len * 3) >> 2;
  const bytes = new Uint8Array(byteLen);
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < len; i++) {
    acc = (acc << 6) | (lut[s.charCodeAt(i)] as number);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[o++] = (acc >>> bits) & 0xff;
    }
  }

  const out = new Int32Array(byteLen >> 2);
  for (let i = 0; i < out.length; i++) {
    const b0 = bytes[i * 4 + 0] as number;
    const b1 = bytes[i * 4 + 1] as number;
    const b2 = bytes[i * 4 + 2] as number;
    const b3 = bytes[i * 4 + 3] as number;
    // `|` yields an int32, so the high byte lands as the sign bit.
    out[i] = b0 | (b1 << 8) | (b2 << 16) | (b3 << 24);
  }
  return out;
}

/** sin(2*pi*i/1024) in 16.16, for i in [0, 1024). */
export const SIN_TABLE_DATA: Int32Array = unpack(PACKED);
