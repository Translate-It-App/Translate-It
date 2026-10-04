import { readFileSync } from 'node:fs';

const months = new Map([
  ['January', 1], ['February', 2], ['March', 3], ['April', 4],
  ['May', 5], ['June', 6], ['July', 7], ['August', 8],
  ['September', 9], ['October', 10], ['November', 11], ['December', 12],
]);

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

const [tag, changelogPath, vueVersion] = process.argv.slice(2);
if (!tag || !/^v\d+\.\d+\.\d+$/.test(tag) || !changelogPath || process.argv.length !== 5) {
  fail('usage: release-notes.mjs vMAJOR.MINOR.PATCH docs/Changelog.md VUE_VERSION');
}
if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(vueVersion)) fail('VUE_VERSION must be a concrete semantic version');

let changelog;
try {
  changelog = readFileSync(changelogPath, 'utf8');
} catch {
  fail(`could not read changelog: ${changelogPath}`);
}

const lines = changelog.split(/\r?\n/);
const matchingHeadings = [];
for (let index = 0; index < lines.length; index++) {
  const heading = lines[index].match(/^#### v(\d+\.\d+\.\d+)(?=$|[^\d.])/);
  if (heading?.[1] === tag.slice(1)) matchingHeadings.push({ index, line: lines[index] });
}
if (matchingHeadings.length !== 1) fail(`expected exactly one release heading for ${tag}`);

const { index, line } = matchingHeadings[0];
const heading = line.match(/^#### v\d+\.\d+\.\d+ – Released on ([A-Za-z]+) (\d{2}), (\d{4})$/);
if (!heading) fail(`release heading for ${tag} has an invalid format or date`);
const [, monthName, dayText, yearText] = heading;
const month = months.get(monthName);
const day = Number(dayText);
const year = Number(yearText);
const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
if (!month || year < 1 || day < 1 || day > daysInMonth[month - 1]) fail(`release heading for ${tag} has an invalid date`);

const section = [];
for (const line of lines.slice(index + 1)) {
  if (/^####\s/.test(line)) break;
  section.push(line);
}
while (section.length && (!section.at(-1).trim() || /^\s*---\s*$/.test(section.at(-1)))) section.pop();
const changelogBody = section.join('\n')
  .replace(/\[((?:[^\[\]]|\[[^\[\]]*\])*)\]\(#\/[^)]*\)/g, '$1')
  .trim();
if (!changelogBody || !changelogBody.split('\n').some(line => {
  const content = line.trim();
  return content && !/^##### (?:Added|Fixed|Changed)$/.test(content) && !/^---$/.test(content);
})) fail(`release section for ${tag} is empty`);
if (/\]\(#\//.test(changelogBody)) fail(`release section for ${tag} contains an unsupported internal link`);

const version = tag.slice(1);
const date = `${dayText} ${monthName} ${yearText}`;
const repository = 'https://github.com/Translate-It-App/Translate-It';
const customNotes = [
  `#### 🌍 Translate It ${tag} – Released on ${date}`,
  '',
  '<div align="center">',
  `  <a href="${repository}/releases"><img src="https://img.shields.io/badge/version-${version}-blue.svg" alt="Version ${version}"></a>`,
  `  <a href="${repository}"><img src="https://img.shields.io/badge/Chrome%20&%20Firefox-Supported-brightgreen" alt="Chrome & Firefox Supported"></a>`,
  '  <a href="https://vite.dev/"><img src="https://img.shields.io/badge/Bundled%20with-Vite-646CFF?logo=vite&logoColor=white" alt="Bundled with Vite"></a>',
  `  <a href="${repository}"><img src="https://img.shields.io/badge/i18n-Multi--Language-blueviolet" alt="i18n Multi-Language"></a>`,
  `  <a href="${repository}"><img src="https://img.shields.io/badge/Vue.js-${vueVersion}-4FC08D?logo=vue.js&logoColor=4FC08D" alt="Vue.js ${vueVersion}"></a>`,
  '</div>',
  '',
  '---',
  '',
  changelogBody,
  '',
  '<br>',
  '',
  '---',
  '',
  '### 🧩 Install Now',
  '',
  'Click your preferred browser to install:',
  '',
  '<div align="center">',
  `  <a href="https://chromewebstore.google.com/detail/translate-it/jfkpmcnebiamnbbkpmmldomjijiahmbd/" target="_blank"><img src="${repository}/raw/refs/heads/main/docs/Store/Chrome-Store.png" alt="Install on Chrome" height="60"></a>`,
  `  <a href="https://addons.mozilla.org/firefox/addon/translate-it/" target="_blank"><img src="${repository}/raw/refs/heads/main/docs/Store/Firefox-Store.png" alt="Install on Firefox" height="60"></a>`,
  '</div>',
].join('\n').trim();

process.stdout.write(customNotes);
