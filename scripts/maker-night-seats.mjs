// Keeps src/_data/makerNightSeats.json in step with Grist (Jamie, 2026-11-07: "make the Maker Night seat
// count follow Grist"). The Maker Night page, the home teaser and llms.txt count seats down from that
// file at build time; this reads the Golden Ticket's count from the order service (GET /api/seats, the
// same Left the order form sells against) and rewrites `sold` when it has changed. The workflow
// maker-night-seats.yml runs it, started hourly by otto-ops' Dagu job sync-maker-night-seats, and
// deploys after a change. A sale on a paper sheet counts once the sheet is entered in Grist.
//
//   node scripts/maker-night-seats.mjs           sync, and say whether the file changed
//   SEATS_URL=... node scripts/...               read another service (the default is the live site)
import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const FILE = new URL('../src/_data/makerNightSeats.json', import.meta.url);
const SITE = new URL('../src/_data/site.json', import.meta.url);
const SEATS_URL = process.env.SEATS_URL ?? 'https://things4good.xyz/api/seats';

// The page's six seats are its own: the copy says "six" in several places. Grist decides how many are
// left, never more than the page's total, and sold is what that leaves. Null when there is nothing to
// change: no Golden Ticket in Grist's current event, or the same count.
export function nextSeats(file, answer) {
  if (answer.total === null || answer.left === null) return null;
  if (!Number.isInteger(answer.total) || !Number.isInteger(answer.left) || answer.left < 0)
    throw new Error(`unexpected seats answer: ${JSON.stringify(answer)}`);
  const sold = file.total - Math.min(answer.left, file.total);
  return sold === file.sold ? null : { ...file, sold };
}

async function readSeats(url, { tries = 3, wait = 5000 } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(url, { headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error(`${url} answered ${response.status}`);
      return await response.json();
    } catch (error) {
      if (attempt >= tries) throw error;
      await new Promise((resolve) => setTimeout(resolve, wait * attempt));
    }
  }
}

async function main() {
  const say = async (changed) => {
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `changed=${changed}\n`);
  };
  const site = JSON.parse(await readFile(SITE, 'utf8'));
  if (site.makerNight !== true) {
    console.log('Maker Night is off in site.json; nothing to count.');
    return say(false);
  }
  const file = JSON.parse(await readFile(FILE, 'utf8'));
  const answer = await readSeats(SEATS_URL);
  if (answer.total !== null && answer.total !== file.total)
    console.log(`Note: Grist has ${answer.total} Golden Tickets (Made + Adjustment), the page counts ${file.total}.`);
  const next = nextSeats(file, answer);
  if (!next) {
    console.log(answer.total === null ? `No Golden Ticket in ${answer.event ?? 'any current event'}; left as is.` : `Maker Night: ${file.total - file.sold} of ${file.total} left, as before.`);
    return say(false);
  }
  await writeFile(FILE, JSON.stringify(next, null, 2) + '\n');
  console.log(`Maker Night: ${next.total - next.sold} of ${next.total} left (was ${file.total - file.sold}).`);
  return say(true);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
