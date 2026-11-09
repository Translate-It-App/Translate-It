export function wrapPageTranslationStart(translatePage, { isProbeStart, report, onStart = () => {}, onSettled = () => {} }) {
  if (typeof translatePage !== 'function' || typeof isProbeStart !== 'function' || typeof report !== 'function'
      || typeof onStart !== 'function' || typeof onSettled !== 'function') {
    throw new TypeError('Page translation start probe requires a method, predicate, reporter, and trace callbacks.');
  }
  let reported = false;
  const reportResult = async (result, failed) => {
    if (!failed && result?.success === true) {
      await report({ success: true, sessionId: result.messageId, code: null });
      return;
    }
    await report({ success: false, sessionId: null, code: 'PROTOCOL_ERROR' });
  };
  return function (...args) {
    const capture = !reported && isProbeStart(args[0]);
    const startedAt = Date.now();
    onStart(this, args, startedAt);
    if (capture) reported = true;
    let result;
    try { result = translatePage.apply(this, args); }
    catch (error) {
      const endedAt = Date.now();
      onSettled(this, args, startedAt, endedAt, undefined, error);
      if (!capture) throw error;
      return Promise.resolve().then(() => reportResult(null, true)).then(() => { throw error; });
    }
    if (!capture) {
      if (result && typeof result.then === 'function') {
        result.then(
          value => onSettled(this, args, startedAt, Date.now(), value, null),
          error => onSettled(this, args, startedAt, Date.now(), undefined, error),
        );
      } else onSettled(this, args, startedAt, Date.now(), result, null);
      return result;
    }
    return Promise.resolve(result).then(async value => {
      onSettled(this, args, startedAt, Date.now(), value, null);
      await reportResult(value, false);
      return value;
    }, async error => {
      onSettled(this, args, startedAt, Date.now(), undefined, error);
      await reportResult(null, true);
      throw error;
    });
  };
}
