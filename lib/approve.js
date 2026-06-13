import readline from 'node:readline/promises';
import process from 'node:process';

export async function confirm(prompt) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  try {
    const answer = await rl.question(`${prompt} [y/n] `);
    return answer.trim().toLowerCase().startsWith('y');
  } finally {
    rl.close();
  }
}

export async function confirmDefaultYes(prompt) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  try {
    const answer = await rl.question(`${prompt} [Y/n] `);
    const normalized = answer.trim().toLowerCase();
    return normalized === '' || normalized.startsWith('y');
  } finally {
    rl.close();
  }
}
