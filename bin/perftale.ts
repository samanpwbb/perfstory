#!/usr/bin/env node
/**
 * perftale CLI.
 *
 * Step 0: usage stub. `analyze <trace.json[.gz]> [--fps <n>]` is wired up in
 * step 1 once the streaming reducer exists.
 */

const USAGE = `perftale — Chrome trace → actionable insights

Usage:
  perftale analyze <trace.json[.gz]> [--fps <n>]   (coming in step 1)
`;

const [command] = process.argv.slice(2);

if (command === 'analyze') {
  console.error('analyze: not implemented yet (lands in step 1)');
  process.exit(1);
} else {
  process.stdout.write(USAGE);
}
