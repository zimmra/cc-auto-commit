#!/usr/bin/env node

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

class AutoCommitHook {
  constructor(config = {}) {
    this.name = 'auto-commit';
    this.config = { ...this.getDefaultConfig(), ...config };
    this.toolLogFile = path.join(process.cwd(), 'claude-tool-events.log');
  }

  getDefaultConfig() {
    return {
      enabled: true,
      matcher: 'Edit|Write|MultiEdit',
      timeout: 30,
      description: 'Automatically commit file changes with contextual messages',
      excludePatterns: [
        '*.log', '*.tmp', '*.temp', '.env*', '*.key', '*.pem', '*.p12', '*.pfx',
        'node_modules/**', '.git/**', '*.pyc', '__pycache__/**'
      ],
      skipEmptyCommits: true,
      addAllFiles: false,
      branchRestrictions: [],
      maxCommitMessageLength: 500,
      commitPrompt: 'Generate a concise git commit message for the following changes. Return only the commit message, no additional text or formatting:'
    };
  }

  logToolEvent(eventType, data) {
    const timestamp = new Date().toISOString();
    const logEntry = {
      timestamp,
      eventType,
      toolName: data.toolName || data.tool_name,
      parameters: Object.keys(data.parameters || data.tool_input || {}),
      sessionId: data.sessionId || data.session_id,
      fullDataKeys: Object.keys(data)
    };

    try {
      fs.appendFileSync(this.toolLogFile, `${JSON.stringify(logEntry, null, 2)}\\n\\n`);
    } catch (error) {
      console.warn(`Failed to log tool event: ${error.message}`);
    }
  }

  async execute(input) {
    try {
      const { tool_name, tool_input, session_id } = input;

      const filePath = tool_input.file_path || tool_input.filePath;

      if (!filePath) {
        return this.error('No file path found in tool input');
      }

      if (!await this.isGitRepository()) {
        return this.success({ message: 'Not in a git repository, skipping commit' });
      }

      if (this.shouldExcludeFile(filePath)) {
        return this.success({ message: `File excluded from auto-commit: ${filePath}` });
      }

      if (await this.isBranchRestricted()) {
        return this.success({ message: 'Current branch is restricted from auto-commits' });
      }

      if (!fs.existsSync(filePath)) {
        return this.error(`File does not exist: ${filePath}`);
      }

      await this.runGitCommand(['add', filePath]);

      if (this.config.skipEmptyCommits && !await this.hasChangesToCommit()) {
        return this.success({ message: 'No changes to commit' });
      }

      const commitMessage = await this.generateCommitMessage(filePath);

      await this.runGitCommand(['commit', '-m', commitMessage]);

      return this.success({
        message: `Successfully committed ${path.basename(filePath)}`,
        filePath: filePath,
        commitMessage: commitMessage
      });

    } catch (error) {
      return this.error(`Auto-commit failed: ${error.message}`);
    }
  }

  async isGitRepository() {
    try {
      await this.runGitCommand(['rev-parse', '--git-dir']);
      return true;
    } catch (error) {
      return false;
    }
  }

  shouldExcludeFile(filePath) {
    const fileName = path.basename(filePath);
    const relativePath = path.relative(process.cwd(), filePath);

    const normalizedRelativePath = relativePath.replace(/\\/g, '/');

    return this.config.excludePatterns.some(pattern => {
      const regex = new RegExp(pattern.replace(/\*\*/g, '.*').replace(/\*/g, '[^/\\\\]*'));
      return regex.test(fileName) || regex.test(normalizedRelativePath);
    });
  }

  async isBranchRestricted() {
    if (this.config.branchRestrictions.length === 0) {
      return false;
    }

    try {
      const currentBranch = await this.runGitCommand(['branch', '--show-current']);
      return this.config.branchRestrictions.includes(currentBranch.trim());
    } catch (error) {
      return false;
    }
  }

  async hasChangesToCommit() {
    try {
      const status = await this.runGitCommand(['status', '--porcelain']);
      return status.trim().length > 0;
    } catch (error) {
      return false;
    }
  }

  async generateCommitMessage(filePath) {
    try {
      // Get the git diff for staged changes
      const gitDiff = await this.runGitCommand(['diff', '--cached']);
      
      // Get git status for additional context
      const gitStatus = await this.runGitCommand(['status', '--porcelain']);
      
      // Construct the prompt for codex
      const contextInfo = `Git Status:\n${gitStatus}\n\nGit Diff:\n${gitDiff}`;
      const fullPrompt = `${this.config.commitPrompt}\n\n${contextInfo}`;
      
      // Run codex to generate commit message
      const codexOutput = await this.runCodexCommand(fullPrompt);
      
      // Parse the JSONL output to extract the agent_message
      const commitMessage = this.parseCodexOutput(codexOutput);
      
      // Truncate if too long
      if (commitMessage.length > this.config.maxCommitMessageLength) {
        return `${commitMessage.substring(0, this.config.maxCommitMessageLength - 3)}...`;
      }
      
      return commitMessage;
    } catch (error) {
      // Fallback to a simple message if codex fails
      const fileName = path.basename(filePath);
      return `Update ${fileName}`;
    }
  }

  async runCodexCommand(prompt) {
    return new Promise((resolve, reject) => {
      const codex = spawn('codex', ['exec', '--json', '--config', 'model_reasoning_effort="low"', prompt], {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: process.cwd()
      });

      let stdout = '';
      let stderr = '';

      codex.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      codex.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      codex.on('close', (code) => {
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(`Codex command failed: ${stderr}`));
        }
      });

      codex.on('error', (error) => {
        reject(error);
      });
    });
  }

  parseCodexOutput(jsonlOutput) {
    const lines = jsonlOutput.trim().split('\n');
    
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.msg && parsed.msg.type === 'agent_message' && parsed.msg.message) {
          return parsed.msg.message.trim();
        }
      } catch (error) {
        // Skip invalid JSON lines
        continue;
      }
    }
    
    // Fallback if no agent_message found
    throw new Error('No agent_message found in codex output');
  }

  runGitCommand(args) {
    return new Promise((resolve, reject) => {
      const git = spawn('git', args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: process.cwd()
      });

      let stdout = '';
      let stderr = '';

      git.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      git.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      git.on('close', (code) => {
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(`Git command failed: ${stderr}`));
        }
      });

      git.on('error', (error) => {
        reject(error);
      });
    });
  }

  success(data = null) {
    return {
      success: true,
      data: data,
      hook: this.name
    };
  }

  error(message, data = null) {
    return {
      success: false,
      error: message,
      data: data,
      hook: this.name
    };
  }

  block(reason) {
    return {
      decision: 'block',
      reason: reason,
      hook: this.name
    };
  }

  approve(reason) {
    return {
      decision: 'approve',
      reason: reason,
      hook: this.name
    };
  }

  static parseInput() {
    return new Promise((resolve, reject) => {
      let input = '';

      process.stdin.on('data', (chunk) => {
        input += chunk.toString();
      });

      process.stdin.on('end', () => {
        try {
          const data = JSON.parse(input);
          resolve(data);
        } catch (error) {
          reject(new Error(`Invalid JSON input: ${error.message}`));
        }
      });

      process.stdin.on('error', (error) => {
        reject(error);
      });
    });
  }

  static outputResult(result) {
    if (result.success === false) {
      console.error(result.error);
      process.exit(result.decision === 'block' ? 2 : 1);
    } else if (result.decision === 'block') {
      console.error(result.reason);
      process.exit(2);
    } else if (result.decision === 'approve') {
      console.log(JSON.stringify(result));
      process.exit(0);
    } else {
      if (result.data) {
        console.log(JSON.stringify(result.data));
      }
      process.exit(0);
    }
  }
}

if (require.main === module) {
  (async () => {
    try {
      const input = await AutoCommitHook.parseInput();
      const hook = new AutoCommitHook();
      const result = await hook.execute(input);
      AutoCommitHook.outputResult(result);
    } catch (error) {
      console.error(`Auto-commit hook error: ${error.message}`);
      process.exit(1);
    }
  })();
}

module.exports = AutoCommitHook;