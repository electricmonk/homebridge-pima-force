// JUnit reporter for CircleCI's Tests tab.
//
// Node's built-in junit reporter hard-codes classname="test" on every
// <testcase>, so CircleCI can't group results by file. This wraps it and
// replaces the classname with the test file's path relative to the repo
// root (taken from the testcase's own file="..." attribute).
import { relative } from 'node:path';
import { junit } from 'node:test/reporters';

export default async function* junitByFile(source) {
  let xml = '';
  for await (const chunk of junit(source)) xml += chunk;
  yield xml.replace(
    /classname="test" file="([^"]*)"/g,
    (_, file) => `classname="${relative(process.cwd(), file)}" file="${file}"`,
  );
}
