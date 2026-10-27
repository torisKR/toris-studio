// 12×18 pixel people. One letter per pixel, "." is transparent.
// Shared colors live in PALETTE; each look adds its own hair and clothes.

export const PALETTE: Record<string, string> = {
  K: "#1b222c", // eyes, outline
  S: "#e8b48e", // skin
  s: "#c98f6c", // skin shade, stubble
  W: "#e8eef5", // shirt, blouse
  G: "#a9bbcf", // glasses frame
  P: "#2b3546", // trousers
  F: "#10151c", // shoes
};

export type Look = { label: string; colors: Record<string, string>; stand: string[]; stride: string[] };

const legs = {
  narrow: { stand: ["..PPPPPPP...", "..PPP.PPP...", "..PPP.PPP...", "..PP...PP...", ".FFF...FFF.."], stride: ["..PPPPPPP...", "..PPP.PP....", ".PPP...PP...", ".PP.....PP..", "FFF.....FFF."] },
  slim: { stand: ["...PPPPPP...", "...PP..PP...", "...PP..PP...", "...PP..PP...", "..FFF..FFF.."], stride: ["...PPPPPP...", "...PP...PP..", "..PP.....PP.", "..PP.....PP.", ".FFF.....FFF"] },
  wide: { stand: ["..PPPPPPPP..", "..PPP..PPP..", "..PP....PP..", "..PP....PP..", ".FFF....FFF."], stride: ["..PPPPPPPP..", "..PP....PP..", ".PP......PP.", ".PP......PP.", "FFF......FFF"] },
};

function look(label: string, colors: Record<string, string>, upper: string[], leg: keyof typeof legs): Look {
  return { label, colors, stand: [...upper, ...legs[leg].stand], stride: [...upper, ...legs[leg].stride] };
}

export const LOOKS = {
  /** Backend Expert: young man, messy black hair, teal hoodie. */
  youngMan: look("젊은 남자", { H: "#1f1a17", T: "#2f7f86", t: "#bfe3e6" }, [
    "..HHHHHHH...",
    ".HHHHHHHHH..",
    ".HHSSSSSHH..",
    ".HSKSSSKSH..",
    "..SSSSSSS...",
    "..SSSsSSS...",
    "...SSSSS....",
    "..TTTSTTT...",
    ".TTTTTTTTT..",
    "TTTTtTtTTTT.",
    "TTTTTTTTTTT.",
    "STTTTTTTTTS.",
    "S.TTTTTTT.S.",
  ], "narrow"),
  /** Frontend Expert: young woman, long brown hair, coral top. */
  youngWoman: look("젊은 여자", { H: "#5b3a29", R: "#d9707a", T: "#e07a5f", t: "#b85c45" }, [
    "...HHHHHH...",
    "..HHHHHHHH..",
    ".HHSSSSSSHH.",
    ".HSKSSSSKSH.",
    ".HSSSSSSSSH.",
    ".HSSSRRSSSH.",
    ".HHSSSSSSHH.",
    ".HH.TSST.HH.",
    ".HTTTTTTTTH.",
    "..TTTTTTTT..",
    ".TTTTTTTTTT.",
    ".STTTTTTTTS.",
    ".S.tttttt.S.",
  ], "slim"),
  /** Supervisor (PM): man in his late 30s, greying side part, glasses, stubble, navy jacket and tie. */
  man30s: look("30대 후반 남자", { H: "#2a2623", g: "#8d949c", J: "#27375a", R: "#c0504d" }, [
    "...HHHHHH...",
    "..HHHHHHHg..",
    "..HSSSSSSH..",
    "..GKGSGKGS..",
    "..SSSSSSSS..",
    "..SsSKKSsS..",
    "...sssss....",
    "..JJWRWJJ...",
    ".JJJWRWJJJ..",
    "JJJJWRWJJJJ.",
    "JJJJJRJJJJJ.",
    "SJJJJJJJJJS.",
    "S.JJJJJJJ.S.",
  ], "narrow"),
  /** QA Reviewer: woman in her late 30s, dark bob, earrings, green cardigan over a white blouse. */
  woman30s: look("30대 후반 여자", { H: "#2b1d1a", R: "#b5606b", A: "#e6be83", C: "#4f7a5a" }, [
    "...HHHHHH...",
    "..HHHHHHHH..",
    ".HHHSSSSHHH.",
    ".HHKSSSSKHH.",
    ".HSSSSSSSSH.",
    ".HSSSRRSSSH.",
    ".HASSSSSSAH.",
    "..H.CWWC.H..",
    ".CCCWWWWCCC.",
    "CCCCWWWWCCCC",
    "CCCCCWWCCCCC",
    "SCCCCCCCCCCS",
    "S.CCCCCCCC.S",
  ], "wide"),
} satisfies Record<string, Look>;

export type LookId = keyof typeof LOOKS;
