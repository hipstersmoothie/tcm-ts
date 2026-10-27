import { styleText } from "node:util";

export const dim = (s: string) => styleText("dim", s);
export const bold = (s: string) => styleText("bold", s);
export const green = (s: string) => styleText("green", s);
export const yellow = (s: string) => styleText("yellow", s);
export const red = (s: string) => styleText("red", s);
export const cyan = (s: string) => styleText("cyan", s);
