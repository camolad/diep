import fs from 'node:fs';
const src = fs.readFileSync(new URL('./meta.js', import.meta.url), 'utf8');
const lib = new Function(src + '\nreturn { parseScore, parseRow, sameName, matchHealth, strengthRatio, rankValue };')();
let bad = 0; const eq = (name, a, b) => { const ok = JSON.stringify(a) === JSON.stringify(b); if (!ok) { bad++; console.log('FAIL', name, JSON.stringify(a), '!=', JSON.stringify(b)); } };
eq('score 12.3k', lib.parseScore('12.3k'), 12300); eq('score 300', lib.parseScore('300'), 300); eq('score 1,234', lib.parseScore('1,234'), 1234);
eq('score 1.5m', lib.parseScore('1.5m'), 1500000); eq('score bad', lib.parseScore('abc'), null); eq('score 23.5K', lib.parseScore('23.5K'), 23500);
eq('row', lib.parseRow('Tester - 8.8k'), { name: 'Tester', score: 8800 }); eq('row dash name', lib.parseRow('a - b - 1.2k'), { name: 'a - b', score: 1200 });
eq('row none', lib.parseRow('Leaderboard'), null); eq('row score only', lib.parseRow('Score: 1.2k'), null); eq('row en dash', lib.parseRow('Zed – 300'), { name: 'Zed', score: 300 });
eq('name eq', lib.sameName('Tester', 'tester'), true); eq('name trunc', lib.sameName('SuperLongNam', 'SuperLongNameHere'), true); eq('name diff', lib.sameName('abc1', 'abd1'), false); eq('name short', lib.sameName('ab', 'abc'), false);
// health bars: back 100..200 at y=300, fill from 100 to 160 -> 0.6, belongs to tank at (150, 250, r 50)
const hm = lib.matchHealth([{ x1: 100, x2: 200, y: 300, kind: 'back' }, { x1: 100, x2: 160, y: 300, kind: 'fill' }, { x1: 400, x2: 500, y: 100, kind: 'back' }], [{ x: 150, y: 250, r: 50 }, { x: 450, y: 40, r: 50 }]);
eq('health 0.6', [...hm], [[0, 0.6]]);
const hm2 = lib.matchHealth([{ x1: 100, x2: 200, y: 300, kind: 'back' }, { x1: 100, x2: 200, y: 300, kind: 'fill' }], [{ x: 450, y: 40, r: 50 }]);
eq('health unmatched', [...hm2], []);
// ranking: the 300-score bot is closer, the tester is stronger / engaged / hurt
const tester = { score: 8800, r: 70, hp: 0.55, dist: 0.5, curDist: 0.4, shotAtMe: 2, hitByMe: 1 };
const bot = { score: 300, r: 55, hp: 1, dist: 0.2, curDist: 0.2, shotAtMe: Infinity, hitByMe: Infinity };
const best = { score: 8800, r: 70 };
for (const mode of ['auto', 'score', 'health', 'threat']) {
  const a = lib.rankValue(tester, mode, lib.strengthRatio(tester, best)), b = lib.rankValue(bot, mode, lib.strengthRatio(bot, best));
  eq('tester beats bot in ' + mode, a > b, true);
}
// no scores: size ratio only
eq('size ratio', +lib.strengthRatio({ score: null, r: 55 }, { score: null, r: 70 }).toFixed(3), 0.055);
// two equal strangers: closer one wins in auto
const A = { score: null, r: 60, hp: 1, dist: 0.2, curDist: 0.5, shotAtMe: Infinity, hitByMe: Infinity }, B = { ...A, dist: 0.6 };
eq('closest wins when equal', lib.rankValue(A, 'auto', 1) > lib.rankValue(B, 'auto', 1), true);
console.log(bad ? bad + ' failures' : 'all meta tests passed');
process.exit(bad ? 1 : 0);
