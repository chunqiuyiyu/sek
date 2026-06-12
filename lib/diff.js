/**
 * A simple line-by-line diff generator for write_file tool output.
 * Produces unified-diff-style output without requiring the `diff` command.
 */

function lcsLength(a, b) {
  const m = a.length;
  const n = b.length;
  let prev = new Uint32Array(n + 1);
  let curr = new Uint32Array(n + 1);
  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      if (a[i - 1] === b[j - 1]) {
        curr[j] = prev[j - 1] + 1;
      } else {
        curr[j] = prev[j] > curr[j - 1] ? prev[j] : curr[j - 1];
      }
    }
    [prev, curr] = [curr, prev];
  }
  return prev;
}

function backtrack(a, b, i, j, c) {
  if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
    const ops = backtrack(a, b, i - 1, j - 1, c);
    ops.push({ op: 'eq', line: a[i - 1] });
    return ops;
  }
  if (j > 0 && (i === 0 || c[j] === c[j - 1])) {
    const ops = backtrack(a, b, i, j - 1, c);
    ops.push({ op: 'ins', line: b[j - 1] });
    return ops;
  }
  if (i > 0) {
    const ops = backtrack(a, b, i - 1, j, c);
    ops.push({ op: 'del', line: a[i - 1] });
    return ops;
  }
  return [];
}

function computeOps(oldLines, newLines) {
  if (oldLines.length === 0) {
    return newLines.map((line) => ({ op: 'ins', line }));
  }
  if (newLines.length === 0) {
    return oldLines.map((line) => ({ op: 'del', line }));
  }
  const c = lcsLength(oldLines, newLines);
  return backtrack(oldLines, newLines, oldLines.length, newLines.length, c);
}

/**
 * Split ops into hunks.
 * A hunk starts when we encounter a change (ins/del) or when we have
 * a run of eq lines that follows a change (to provide context).
 */
function groupHunks(ops) {
  const hunks = [];
  let current = [];
  let hasChange = false;
  let eqCount = 0;

  function flush() {
    if (current.length > 0) {
      // Trim trailing context beyond 3 lines
      const lastChange = current.length - 1 - [...current].reverse().findIndex((o) => o.op !== 'eq');
      if (lastChange >= 0) {
        current = current.slice(0, lastChange + 4); // keep up to 3 context lines after last change
      }
      // Trim leading context beyond 3 lines
      const firstChange = current.findIndex((o) => o.op !== 'eq');
      if (firstChange > 3) {
        current = current.slice(firstChange - 3);
      }
      if (current.some((o) => o.op !== 'eq')) {
        hunks.push(current);
      }
      current = [];
      hasChange = false;
      eqCount = 0;
    }
  }

  for (const op of ops) {
    if (op.op === 'eq') {
      if (hasChange) {
        // We're past a change, collect context up to 3 lines
        if (eqCount < 3) {
          current.push(op);
          eqCount += 1;
        } else {
          // We have enough context, but keep going if more changes follow
          // Actually, flush here and start fresh — next change starts new hunk
          flush();
          // But we need to keep the last 3 eq lines as leading context for next hunk
          // Store them in a temporary buffer
          current = [{ op: 'eq', line: op.line }]; // start fresh, but we'll lose context...
          // Better approach: manage leading context separately
        }
      } else {
        // No change yet, collect eq lines (up to 3 leading context)
        if (eqCount < 3) {
          current.push(op);
          eqCount += 1;
        }
        // If we collected 3 and still no change, we can forget them
        // Actually keep sliding window of last 3 eq lines
      }
    } else {
      // A change: if we flushed eq lines, we need to prepend trailing context
      // For simplicity, just add to current
      current.push(op);
      hasChange = true;
      eqCount = 0;
    }
  }
  flush();

  return hunks;
}

export function diffLines(filePath, oldContent, newContent, fileExisted) {
  const oldLines = fileExisted ? oldContent.split(/\n/) : [];
  const newLines = newContent.split(/\n/);

  if (oldLines.length > 0 && oldLines[oldLines.length - 1] === '') oldLines.pop();
  if (newLines.length > 0 && newLines[newLines.length - 1] === '') newLines.pop();

  if (!fileExisted && newLines.length === 0) return '(empty new file)';
  if (fileExisted && oldContent === newContent) return '(no changes)';

  const ops = computeOps(oldLines, newLines);

  // Build hunks with context
  const hunks = [];
  let i = 0;
  while (i < ops.length) {
    // Skip leading eq
    if (ops[i].op === 'eq') { i += 1; continue; }

    // Start a hunk: capture up to 3 preceding eq lines
    const before = [];
    let lookback = i - 1;
    while (lookback >= 0 && ops[lookback].op === 'eq' && before.length < 3) {
      before.unshift(ops[lookback]);
      lookback -= 1;
    }

    // Collect the change block (all consecutive non-eq ops)
    const change = [];
    while (i < ops.length && ops[i].op !== 'eq') {
      change.push(ops[i]);
      i += 1;
    }

    // Collect up to 3 following eq lines
    const after = [];
    while (i < ops.length && ops[i].op === 'eq' && after.length < 3) {
      after.push(ops[i]);
      i += 1;
    }

    hunks.push([...before, ...change, ...after]);
  }

  // Format hunks
  const out = [];
  let oldLine = 0;
  let newLine = 0;

  // Track positions for all lines to compute correct line numbers
  // We need to know the old/new line numbers at each op position
  // Re-compute by walking through all ops once to get line mapping
  const oldPos = new Array(ops.length);
  const newPos = new Array(ops.length);
  let ol = 0, nl = 0;
  for (let idx = 0; idx < ops.length; idx += 1) {
    oldPos[idx] = ol;
    newPos[idx] = nl;
    if (ops[idx].op === 'eq' || ops[idx].op === 'del') ol += 1;
    if (ops[idx].op === 'eq' || ops[idx].op === 'ins') nl += 1;
  }

  // Map hunk ops back to their global positions
  let opIdx = 0;
  for (const hunk of hunks) {
    // Find the global start index of this hunk
    const startPos = ops.indexOf(hunk[0]);
    if (startPos === -1) continue;

    const hdrOld = oldPos[startPos] + 1;
    const hdrNew = newPos[startPos] + 1;

    let oc = 0, nc = 0;
    for (const op of hunk) {
      if (op.op === 'eq' || op.op === 'del') oc += 1;
      if (op.op === 'eq' || op.op === 'ins') nc += 1;
    }

    out.push(`@@ -${hdrOld},${oc} +${hdrNew},${nc} @@`);
    for (const op of hunk) {
      if (op.op === 'eq') out.push(` ${op.line}`);
      else if (op.op === 'del') out.push(`-${op.line}`);
      else out.push(`+${op.line}`);
    }
  }

  return fileExisted ? out.join('\n') : `(new file)\n${out.join('\n')}`;
}
