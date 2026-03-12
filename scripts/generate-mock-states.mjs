#!/usr/bin/env node
/**
 * Generate 250 dummy flight states in OpenSky format.
 * Run: node scripts/generate-mock-states.mjs
 */

const existingIcao = new Set([
  '8a03e0', '76dfe3', '75044f', '7c4510', '738065', '4841d8', '4ca1a2', '4008f2',
  'a2d1c1', 'c01abc', 'e49a88', 'ae1467', '484175', 'ab23cd', '71bc15', '896419',
  '39b415', '4b1805', '780db7', '885176'
]);

const countries = [
  'Indonesia', 'Singapore', 'Malaysia', 'Australia', 'Taiwan', 'Netherlands', 'Ireland',
  'United Kingdom', 'United States', 'Canada', 'Brazil', 'Germany', 'Japan', 'United Arab Emirates',
  'France', 'Switzerland', 'China', 'Thailand', 'India', 'South Korea', 'Philippines', 'Vietnam',
  'Mexico', 'Argentina', 'Chile', 'Colombia', 'Spain', 'Italy', 'Portugal', 'Poland', 'Turkey',
  'Egypt', 'South Africa', 'Nigeria', 'Kenya', 'Saudi Arabia', 'Israel', 'Pakistan', 'Bangladesh',
  'Russia', 'Ukraine', 'Sweden', 'Norway', 'Denmark', 'Finland', 'Austria', 'Belgium', 'Greece',
  'New Zealand', 'Hong Kong', 'Sri Lanka', 'Morocco', 'Peru', 'Ecuador', 'Venezuela'
];

const airlinePrefixes = [
  'GIA', 'SIA', 'MAS', 'QFA', 'EVA', 'KLM', 'RYR', 'BAW', 'UAL', 'ACA', 'AZU', 'JBU',
  'DLH', 'AAL', 'ANA', 'UAE', 'AFR', 'SWR', 'CSN', 'THA', 'IND', 'KAL', 'PAL', 'VNA',
  'AMX', 'ARG', 'LAN', 'AVI', 'IBE', 'ITY', 'TAP', 'LOT', 'THY', 'MSR', 'SAA', 'ETH',
  'SVA', 'ELY', 'PIA', 'BGD', 'AFL', 'UKL', 'SAS', 'NAX', 'TAP', 'AUA', 'BEL', 'AEE',
  'ANZ', 'CPA', 'UL', 'RAM', 'LPE', 'TAME', 'LAV', 'WZZ', 'EZY', 'VLG', 'EWG'
];

function randomHex6() {
  let s;
  do {
    s = Array.from({ length: 6 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  } while (existingIcao.has(s));
  existingIcao.add(s);
  return s;
}

function randomCallsign() {
  const prefix = airlinePrefixes[Math.floor(Math.random() * airlinePrefixes.length)];
  const num = String(Math.floor(Math.random() * 9999)).padStart(4, '0');
  const suffix = Math.random() > 0.7 ? String.fromCharCode(65 + Math.floor(Math.random() * 26)) : ' ';
  return (prefix + num + suffix).padEnd(8, ' ').slice(0, 8);
}

function randomInRange(min, max, decimals = 4) {
  const v = min + Math.random() * (max - min);
  return decimals ? Number(v.toFixed(decimals)) : Math.round(v);
}

const baseTime = 1762342800;
const newStates = [];

for (let i = 0; i < 250; i++) {
  const onGround = Math.random() < 0.08;
  const baroAlt = onGround ? 0 : randomInRange(300, 12500, 0);
  const geoAlt = onGround ? 0 : baroAlt + randomInRange(-200, 300, 0);
  const velocity = onGround ? randomInRange(0, 25, 1) : randomInRange(80, 280, 1);
  const verticalRate = onGround ? 0 : randomInRange(-15, 15, 1);
  const timePos = baseTime - randomInRange(0, 12, 0);
  const lastContact = baseTime;

  const state = [
    randomHex6(),
    randomCallsign(),
    countries[Math.floor(Math.random() * countries.length)],
    timePos,
    lastContact,
    randomInRange(-180, 180),
    randomInRange(-60, 75),
    baroAlt,
    onGround,
    velocity,
    randomInRange(0, 360, 1),
    verticalRate,
    null,
    geoAlt,
    String(randomInRange(0, 7777, 0)).padStart(4, '0'),
    false,
    0,
    onGround ? (Math.random() > 0.5 ? 16 : 17) : (Math.random() > 0.7 ? 3 : 4)
  ];
  newStates.push(JSON.stringify(state));
}

console.log(newStates.map(s => '    ' + s).join(',\n'));
