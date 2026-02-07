import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';

const execFileAsync = promisify(execFile);

const TASK_NAME = 'PropsCashDaily';

export interface ScheduleInfo {
  exists: boolean;
  enabled: boolean;
  time: string | null;
  nextRun: string | null;
}

export class Scheduler {
  private projectRoot: string;
  private batchPath: string;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
    this.batchPath = path.join(projectRoot, 'scripts', 'run-daily.bat');
  }

  private async ps(command: string): Promise<string> {
    try {
      const { stdout } = await execFileAsync('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        command,
      ]);
      return stdout.trim();
    } catch (err: any) {
      if (
        err.stderr?.includes('No MSFT_ScheduledTask') ||
        err.stderr?.includes('cannot find') ||
        err.stderr?.includes('does not exist') ||
        err.message?.includes('ObjectNotFound')
      ) {
        return '';
      }
      throw err;
    }
  }

  async getScheduleInfo(): Promise<ScheduleInfo> {
    const noTask: ScheduleInfo = { exists: false, enabled: false, time: null, nextRun: null };

    try {
      const script = `
        $ErrorActionPreference = 'Stop'
        try {
          $task = Get-ScheduledTask -TaskName '${TASK_NAME}'
          $info = Get-ScheduledTaskInfo -TaskName '${TASK_NAME}'
          $trigger = $task.Triggers[0]
          $time = if ($trigger.StartBoundary) {
            ([datetime]$trigger.StartBoundary).ToString('HH:mm')
          } else { $null }
          $nextRun = if ($info.NextRunTime -and $info.NextRunTime -ne [DateTime]::MinValue) {
            $info.NextRunTime.ToString('o')
          } else { $null }
          @{
            State = $task.State.ToString()
            Time = $time
            NextRun = $nextRun
          } | ConvertTo-Json
        } catch {
          '{"State":"NotFound"}'
        }
      `;

      const output = await this.ps(script);
      if (!output || output.includes('NotFound')) return noTask;

      const parsed = JSON.parse(output);
      return {
        exists: true,
        enabled: parsed.State === 'Ready',
        time: parsed.Time || null,
        nextRun: parsed.NextRun || null,
      };
    } catch {
      return noTask;
    }
  }

  async enable(time: string): Promise<{ success: boolean; error?: string }> {
    try {
      const [hours, minutes] = time.split(':');
      const batchPathEscaped = this.batchPath.replace(/'/g, "''");
      const projectRootEscaped = this.projectRoot.replace(/'/g, "''");

      await this.ps(
        `Unregister-ScheduledTask -TaskName '${TASK_NAME}' -Confirm:$false -ErrorAction SilentlyContinue`
      );

      const script = `
        $action = New-ScheduledTaskAction -Execute '${batchPathEscaped}' -WorkingDirectory '${projectRootEscaped}'
        $trigger = New-ScheduledTaskTrigger -Daily -At '${hours}:${minutes}'
        $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
        Register-ScheduledTask -TaskName '${TASK_NAME}' -Action $action -Trigger $trigger -Settings $settings -Description 'Props.cash daily automation run'
      `;

      await this.ps(script);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message || 'Failed to create scheduled task' };
    }
  }

  async disable(): Promise<{ success: boolean; error?: string }> {
    try {
      await this.ps(
        `Unregister-ScheduledTask -TaskName '${TASK_NAME}' -Confirm:$false -ErrorAction SilentlyContinue`
      );
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message || 'Failed to remove scheduled task' };
    }
  }

  async updateTime(time: string): Promise<{ success: boolean; error?: string }> {
    const info = await this.getScheduleInfo();
    if (!info.exists) {
      return this.enable(time);
    }

    try {
      const [hours, minutes] = time.split(':');
      const script = `
        $trigger = New-ScheduledTaskTrigger -Daily -At '${hours}:${minutes}'
        Set-ScheduledTask -TaskName '${TASK_NAME}' -Trigger $trigger
      `;
      await this.ps(script);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message || 'Failed to update schedule' };
    }
  }
}
