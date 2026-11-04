import { describe, expect, it } from 'vitest';
import { getMap, MAP_IDS } from '../game/map';
import { PALETTE, SPRITE_ART } from './sprites';

describe('sprites', () => {
  for (const [name, rows] of Object.entries(SPRITE_ART)) {
    it(`${name} is a clean rectangle using palette colours`, () => {
      const width = rows[0].length;
      for (const row of rows) {
        expect(row.length, row).toBe(width);
        for (const letter of row) {
          if (letter !== '.') expect(PALETTE[letter], `unknown colour "${letter}"`).toBeDefined();
        }
      }
    });
  }

  for (const id of MAP_IDS) {
    it(`every landmark on ${id} has a sprite`, () => {
      for (const { kind } of getMap(id).landmarks) {
        expect(SPRITE_ART, `no sprite for ${kind}`).toHaveProperty(kind);
      }
    });
  }
});
