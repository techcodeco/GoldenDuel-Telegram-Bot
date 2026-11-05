import { describe, expect, test } from "bun:test";
import { isGroupTrigger } from "../src/filter";

describe("gateway group trigger allow-list", () => {
  test("routes all supported Persian duel words", () => {
    for (const word of ["دوئل", "فایت", "رقابت", "چالش", "چلنج", "چالنج"]) {
      expect(isGroupTrigger(word)).toBe(true);
    }
  });

  test("routes supported English challenge words and commands", () => {
    for (const word of ["duel", "/duel", "fight", "/fight", "challenge", "/challenge", "competition", "/competition"]) {
      expect(isGroupTrigger(word)).toBe(true);
    }
  });

  test("does not route ordinary group conversation", () => {
    for (const word of ["سلام دوستان", "hello everyone", "من می‌خوام بازی کنم", "چالش خیلی خوب بود"]) {
      expect(isGroupTrigger(word)).toBe(false);
    }
  });
});
