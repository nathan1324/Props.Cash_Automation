import { spawn, ChildProcessWithoutNullStreams } from 'child_process';

export class ProcessManager {
  private projectRoot: string;
  private activeChild: ChildProcessWithoutNullStreams | null = null;
  private activeType: string | null = null;
  private doneCallback: ((type: string, code: number | null) => void) | null = null;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
  }

  isRunning(): boolean {
    return this.activeChild !== null;
  }

  getRunningType(): string | null {
    return this.activeType;
  }

  onDone(callback: (type: string, code: number | null) => void): void {
    this.doneCallback = callback;
  }

  spawn(
    type: string,
    scriptArgs: string[],
    onOutput: (line: string) => void
  ): void {
    if (this.activeChild) {
      throw new Error('A process is already running');
    }

    this.activeType = type;

    const child = spawn('npx', ['tsx', ...scriptArgs], {
      cwd: this.projectRoot,
      shell: true,
      env: { ...process.env },
    });

    this.activeChild = child;

    child.stdout.on('data', (data: Buffer) => {
      const lines = data.toString().split(/\r?\n/).filter(l => l.length > 0);
      for (const line of lines) {
        onOutput(line + '\n');
      }
    });

    child.stderr.on('data', (data: Buffer) => {
      const lines = data.toString().split(/\r?\n/).filter(l => l.length > 0);
      for (const line of lines) {
        onOutput('[stderr] ' + line + '\n');
      }
    });

    child.on('close', (code) => {
      const finishedType = this.activeType!;
      this.activeChild = null;
      this.activeType = null;
      onOutput(`\n--- Process "${finishedType}" exited with code ${code} ---\n`);
      this.doneCallback?.(finishedType, code);
    });

    child.on('error', (err) => {
      const finishedType = this.activeType!;
      this.activeChild = null;
      this.activeType = null;
      onOutput(`\n--- Process "${finishedType}" error: ${err.message} ---\n`);
      this.doneCallback?.(finishedType, null);
    });
  }

  killActive(): void {
    if (this.activeChild) {
      this.activeChild.kill();
      this.activeChild = null;
      this.activeType = null;
    }
  }
}
