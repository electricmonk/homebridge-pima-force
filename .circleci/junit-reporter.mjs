// JUnit reporter for CircleCI's Tests tab, with the test file as classname.
//
// Node's built-in junit reporter can't be used for this: its classname is
// "test" or the parent suite's name depending on the Node release, and
// Node 22 doesn't write the file attribute at all. Every test:pass and
// test:fail event does carry its file, so the XML is built from those.
//
// Output: one <testsuite> per test file. Each leaf test becomes a
// <testcase classname="src/foo.test.ts" name="Suite > nested > test">.
import { relative } from 'node:path';
import { inspect } from 'node:util';

const xml = (s) =>
  String(s)
    // Characters XML 1.0 forbids (ANSI colour codes in errors, mostly).
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

export default async function* junitByFile(source) {
  // Per file, completed tests waiting for their parent, keyed by nesting.
  // Children complete before their parent, so a test at nesting n adopts
  // whatever is pending at n + 1 when it completes.
  const pending = new Map();
  const files = [];

  for await (const { type, data } of source) {
    if (type !== 'test:pass' && type !== 'test:fail') continue;
    const file = data.file ?? '<unknown>';
    if (!pending.has(file)) {
      pending.set(file, []);
      files.push(file);
    }
    const levels = pending.get(file);
    const children = levels[data.nesting + 1] ?? [];
    levels[data.nesting + 1] = [];
    (levels[data.nesting] ??= []).push({
      name: data.name,
      failed: type === 'test:fail',
      skipped: data.skip !== undefined || data.todo !== undefined,
      seconds: (data.details?.duration_ms ?? 0) / 1000,
      error: data.details?.error,
      children,
    });
  }

  yield '<?xml version="1.0" encoding="utf-8"?>\n<testsuites>\n';
  for (const file of files) {
    const classname = file === '<unknown>' ? file : relative(process.cwd(), file);
    const cases = [];
    const walk = (node, path) => {
      const name = [...path, node.name].join(' > ');
      const childFailed = node.children.some(function failed(c) {
        return c.failed || c.children.some(failed);
      });
      node.children.forEach((c) => walk(c, [...path, node.name]));
      // Leaves are testcases. A parent is one too if it failed on its own
      // (e.g. a hook threw), so that failure isn't lost.
      if (node.children.length === 0 || (node.failed && !childFailed)) {
        cases.push({ ...node, name });
      }
    };
    for (const root of pending.get(file)[0] ?? []) walk(root, []);

    const failures = cases.filter((c) => c.failed).length;
    const skipped = cases.filter((c) => c.skipped).length;
    const time = cases.reduce((t, c) => t + c.seconds, 0);
    yield `\t<testsuite name="${xml(classname)}" tests="${cases.length}" failures="${failures}" skipped="${skipped}" errors="0" time="${time}">\n`;
    for (const c of cases) {
      const attrs = `classname="${xml(classname)}" name="${xml(c.name)}" file="${xml(classname)}" time="${c.seconds}"`;
      if (c.failed) {
        const err = c.error?.cause ?? c.error;
        const message = err?.message ?? String(err ?? 'failed');
        yield `\t\t<testcase ${attrs}>\n\t\t\t<failure message="${xml(message)}">${xml(inspect(err))}</failure>\n\t\t</testcase>\n`;
      } else if (c.skipped) {
        yield `\t\t<testcase ${attrs}>\n\t\t\t<skipped/>\n\t\t</testcase>\n`;
      } else {
        yield `\t\t<testcase ${attrs}/>\n`;
      }
    }
    yield '\t</testsuite>\n';
  }
  yield '</testsuites>\n';
}
