const digest = value => /^[a-f\d]{64}$/i.test(value ?? '');

function validField(field, hasPresence = false) {
  return field && typeof field === 'object' && Number.isSafeInteger(field.size) && field.size >= 0
    && digest(field.sha256) && typeof field.matchesExpected === 'boolean'
    && (!hasPresence || typeof field.present === 'boolean');
}

export function compareRestoreDOMSnapshots(baseline, final) {
  if (!baseline || !final || !baseline.htmlClass || !final.htmlClass
      || typeof baseline.htmlClass.present !== 'boolean' || typeof final.htmlClass.present !== 'boolean'
      || (baseline.htmlClass.present ? typeof baseline.htmlClass.value !== 'string' : baseline.htmlClass.value !== null)
      || (final.htmlClass.present ? typeof final.htmlClass.value !== 'string' : final.htmlClass.value !== null)
      || !Array.isArray(baseline.targets) || !Array.isArray(final.targets)
      || baseline.targets.length !== 12 || final.targets.length !== 12) throw new TypeError('Restore DOM diagnostic snapshots are malformed.');

  const finalById = new Map(final.targets.map(target => [target.id, target]));
  if (finalById.size !== 12) throw new TypeError('Restore DOM diagnostic target IDs are malformed.');
  const htmlClassEqual = baseline.htmlClass.present === final.htmlClass.present
    && baseline.htmlClass.value === final.htmlClass.value;
  const targets = baseline.targets.map(before => {
    const after = finalById.get(before.id);
    if (!after || !/^target-(?:[0-9]|1[01])$/.test(before.id) || before.kind !== after.kind
        || !['text', 'title'].includes(before.kind)) throw new TypeError('Restore DOM diagnostic target identity is malformed.');
    for (const field of ['text', 'markup']) if (!validField(before[field]) || !validField(after[field])) throw new TypeError('Restore DOM diagnostic field is malformed.');
    if (!validField(before.title, true) || !validField(after.title, true)) throw new TypeError('Restore DOM diagnostic title is malformed.');
    const compareField = (left, right) => ({
      baseline: { size: left.size, sha256: left.sha256, matchesExpected: left.matchesExpected },
      final: { size: right.size, sha256: right.sha256, matchesExpected: right.matchesExpected },
      unchanged: left.size === right.size && left.sha256 === right.sha256,
      restored: right.matchesExpected === true && left.size === right.size && left.sha256 === right.sha256,
    });
    const titleEqual = before.title.present === after.title.present && before.title.size === after.title.size
      && before.title.sha256 === after.title.sha256;
    return {
      id: before.id,
      kind: before.kind,
      text: compareField(before.text, after.text),
      markup: compareField(before.markup, after.markup),
      title: {
        baseline: { present: before.title.present, size: before.title.size, sha256: before.title.sha256, matchesExpected: before.title.matchesExpected },
        final: { present: after.title.present, size: after.title.size, sha256: after.title.sha256, matchesExpected: after.title.matchesExpected },
        unchanged: titleEqual,
        restored: after.title.matchesExpected === true && titleEqual,
      },
    };
  });
  const classSummary = {
    baseline: { present: baseline.htmlClass.present, value: baseline.htmlClass.value },
    final: { present: final.htmlClass.present, value: final.htmlClass.value },
    equal: htmlClassEqual,
  };
  return {
    available: true,
    matchesOriginal: htmlClassEqual && targets.every(target => target.text.restored && target.markup.restored && target.title.restored),
    htmlClass: classSummary,
    targets,
  };
}
