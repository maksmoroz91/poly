import { test } from 'node:test';
import assert from 'node:assert/strict';
import { categorize, priorityOf } from '../src/categorize.js';

test('esports keywords win over generic category', () => {
  const m = { question: 'Will Team Liquid win the CS2 Major?', category: 'Sports' };
  assert.equal(categorize(m), 'esports');
});

test('dota 2 classifier', () => {
  assert.equal(categorize({ question: 'Team Spirit vs OG — Dota 2 final' }), 'esports');
});

test('league of legends worlds classifier', () => {
  assert.equal(categorize({ question: 'Will T1 win Worlds 2026?' }), 'esports');
});

test('valorant classifier', () => {
  assert.equal(categorize({ question: 'VCT champions winner?' }), 'esports');
});

test('politics classifier', () => {
  assert.equal(
    categorize({ question: 'Will Candidate X win the presidential election?' }),
    'politics',
  );
});

test('crypto classifier', () => {
  assert.equal(categorize({ question: 'Will BTC close above $100k?' }), 'crypto');
});

test('other fallback', () => {
  assert.equal(categorize({ question: 'Will it rain in Tokyo tomorrow?' }), 'other');
});

test('priorityOf ranks esports highest', () => {
  assert.ok(priorityOf('esports') < priorityOf('politics'));
  assert.ok(priorityOf('politics') < priorityOf('crypto'));
  assert.ok(priorityOf('crypto') < priorityOf('other'));
});
