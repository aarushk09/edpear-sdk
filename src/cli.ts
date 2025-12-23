#!/usr/bin/env node

import { Command } from 'commander';
import inquirer from 'inquirer';
import chalk from 'chalk';
import ora from 'ora';
import open from 'open';
import axios from 'axios';
import fs from 'fs-extra';
import path from 'path';
import { homedir } from 'os';
import dotenv from 'dotenv';

// Load environment variables from .env or .env.local if they exist
dotenv.config();
dotenv.config({ path: path.join(process.cwd(), '.env.local') });

const program = new Command();

// Configuration
const CONFIG_DIR = path.join(homedir(), '.edpear');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const ENV_FILE = path.join(process.cwd(), '.env.local');

// Default production URL
const DEFAULT_API_URL = 'https://edpearofficial.vercel.app';

interface Config {
  token?: string;
  user?: {
    id: string;
    name: string;
    email: string;
    credits: number;
  };
  apiKeys?: Array<{
    id: string;
    key: string;
    name: string;
    createdAt: string;
  }>;
}

class EdPearCLI {
  private config: Config = {};

  constructor() {
    this.loadConfig();
  }

  private loadConfig() {
    try {
      if (fs.existsSync(CONFIG_FILE)) {
        this.config = fs.readJsonSync(CONFIG_FILE);
      }
    } catch (error) {
      // Ignore config loading errors on first run
    }
  }

  private saveConfig() {
    try {
      fs.ensureDirSync(CONFIG_DIR);
      fs.writeJsonSync(CONFIG_FILE, this.config, { spaces: 2 });
    } catch (error) {
      console.error(chalk.red('Error saving config:'), error);
    }
  }

  private async makeRequest(endpoint: string, data?: any, method: string = 'GET') {
    const baseURL = process.env.EDPEAR_API_URL || DEFAULT_API_URL;
    
    try {
      const response = await axios({
        method,
        url: `${baseURL}${endpoint}`,
        data,
        headers: {
          'Content-Type': 'application/json',
          ...(this.config.token && { 'Authorization': `Bearer ${this.config.token}` }),
        },
      });
      return response.data;
    } catch (error: any) {
      if (error.response?.status === 401) {
        console.error(chalk.red('Authentication required. Please run "edpear login" first.'));
        process.exit(1);
      }
      throw error;
    }
  }

  async login() {
    console.log(chalk.blue('🔐 EdPear Authentication'));
    
    const baseURL = process.env.EDPEAR_API_URL || DEFAULT_API_URL;
    
    console.log(chalk.gray(`Connecting to: ${baseURL}`));
    console.log(chalk.yellow('Press ENTER to open the browser for authentication...'));

    await inquirer.prompt([
      {
        type: 'input',
        name: 'enter',
        message: '',
      },
    ]);

    try {
      // 1. Initialize CLI auth session
      const initResponse = await axios.post(`${baseURL}/api/auth/cli/init`);
      const { requestId, url } = initResponse.data;

      // 2. Open browser
      await open(url);
      console.log(chalk.green('✅ Browser opened!'));
      console.log(chalk.yellow('Please login and approve the request in your browser.'));
      console.log(chalk.gray('The CLI will automatically detect when you are authenticated.\n'));
      // 3. Poll for completion
      const spinner = ora('Waiting for approval...').start();
      const maxAttempts = 200; // 10 minutes
      let attempts = 0;

      while (attempts < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        try {
          // Poll status using requestId
          const statusResponse = await axios.get(`${baseURL}/api/auth/cli/status?requestId=${requestId}`);
          
          if (statusResponse.data.status === 'completed' && statusResponse.data.cliToken) {
            spinner.stop();
            
            // Save token and user data
            this.config.token = statusResponse.data.cliToken;
            this.config.user = statusResponse.data.user;
            this.saveConfig();

            console.log(chalk.green('\n✅ Successfully authenticated!'));
            console.log(chalk.blue(`\nWelcome, ${statusResponse.data.user.name}!`));
            console.log(chalk.gray(`Email: ${statusResponse.data.user.email}`));
            console.log(chalk.gray(`Credits: ${statusResponse.data.user.credits}`));
            return;
          } else if (statusResponse.data.status === 'expired') {
            spinner.stop();
            console.log(chalk.red(`\n❌ Authentication request expired. Please try again.`));
            process.exit(1);
          }
          
          attempts++;
        } catch (error: any) {
          // Continue polling on error
          attempts++;
        }
      }

      spinner.stop();
      console.log(chalk.yellow('\n⏱️  Authentication timeout. Please try again.'));
      process.exit(1);

    } catch (error: any) {
      console.error(chalk.red('Error during login:'), error.message);
      process.exit(1);
    }
  }

  async generateKey() {
    if (!this.config.token) {
      console.error(chalk.red('Please login first: edpear login'));
      process.exit(1);
    }

    console.log(chalk.blue('🔑 Generate New API Key\n'));

    const { name } = await inquirer.prompt([
      {
        type: 'input',
        name: 'name',
        message: 'Enter a name for your API key:',
        default: 'My API Key',
        validate: (input: string) => {
          if (!input.trim()) {
            return 'Name is required';
          }
          return true;
        },
      },
    ]);

    const spinner = ora('Generating API key...').start();

    try {
      const result = await this.makeRequest('/api/keys/generate', {
        name,
      }, 'POST');

      spinner.succeed(chalk.green('✅ API key generated successfully!'));

      // Add to config
      if (!this.config.apiKeys) {
        this.config.apiKeys = [];
      }
      this.config.apiKeys.push(result.apiKey);
      this.saveConfig();

      console.log(chalk.blue('\n📋 Your new API key:'));
      console.log(chalk.yellow(result.apiKey.key));
      console.log(chalk.gray('\n💡 Save this key securely. It will not be shown again.'));

      // Ask if user wants to save to .env.local
      const { saveToEnv } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'saveToEnv',
          message: 'Save API key to .env.local file?',
          default: true,
        },
      ]);

      if (saveToEnv) {
        await this.saveToEnvFile(result.apiKey.key);
      }
    } catch (error: any) {
      spinner.fail(chalk.red('❌ Failed to generate API key'));
      console.error(chalk.red('Error:'), error.response?.data?.error || error.message);
      process.exit(1);
    }
  }

  private async saveToEnvFile(apiKey: string) {
    try {
      let envContent = '';
      
      if (fs.existsSync(ENV_FILE)) {
        envContent = fs.readFileSync(ENV_FILE, 'utf8');
      }

      // Remove existing EDPEAR_API_KEY if present
      envContent = envContent.replace(/^EDPEAR_API_KEY=.*$/m, '');
      
      // Add new API key
      if (envContent && !envContent.endsWith('\n')) {
        envContent += '\n';
      }
      envContent += `EDPEAR_API_KEY=${apiKey}\n`;

      fs.writeFileSync(ENV_FILE, envContent);
      console.log(chalk.green('✅ API key saved to .env.local'));
    } catch (error) {
      console.error(chalk.red('Error saving to .env.local:'), error);
    }
  }

  async status() {
    if (!this.config.token) {
      console.log(chalk.red('❌ Not authenticated'));
      console.log(chalk.gray('Run "edpear login" to get started'));
      return;
    }

    const spinner = ora('Fetching status...').start();

    try {
      // Fetch latest user stats and API keys
      const [userStatus, keysResponse] = await Promise.all([
        this.makeRequest('/api/auth/me'),
        this.makeRequest('/api/keys/list')
      ]);

      spinner.stop();

      console.log(chalk.blue('📊 EdPear Status\n'));
      
      if (userStatus.user) {
        // Update local config
        this.config.user = {
          id: userStatus.user.id,
          name: userStatus.user.name,
          email: userStatus.user.email,
          credits: userStatus.user.credits
        };
        this.saveConfig();

        console.log(chalk.green(`👤 User: ${userStatus.user.name}`));
        console.log(chalk.green(`📧 Email: ${userStatus.user.email}`));
        console.log(chalk.green(`💳 Credits: ${userStatus.user.credits}`));
      }

      const apiKeys = keysResponse.apiKeys || [];
      
      if (apiKeys.length > 0) {
        console.log(chalk.blue(`\n🔑 Latest API Keys (Top 5):`));
        // Show top 5 keys
        apiKeys.slice(0, 5).forEach((key: any, index: number) => {
          console.log(chalk.gray(`  ${index + 1}. ${key.name}`));
          // The API returns masked keys, which is good for status
          console.log(chalk.yellow(`     ${key.key}`)); 
          console.log(chalk.gray(`     Created: ${new Date(key.createdAt).toLocaleDateString()}`));
          if (key.usageCount !== undefined) {
             console.log(chalk.gray(`     Uses: ${key.usageCount}`));
          }
        });
      } else {
        console.log(chalk.yellow('\n🔑 No API keys found'));
        console.log(chalk.gray('Run "edpear generate-key" to create your first API key'));
      }

    } catch (error: any) {
      spinner.fail(chalk.red('❌ Failed to fetch status'));
      // Fallback to local config if API fails
      if (this.config.user) {
        console.log(chalk.gray('\nShowing cached data:'));
        console.log(chalk.green(`👤 User: ${this.config.user.name}`));
        console.log(chalk.green(`📧 Email: ${this.config.user.email}`));
        console.log(chalk.green(`💳 Credits: ${this.config.user.credits}`));
      }
    }
  }

  async logout() {
    if (!this.config.token) {
      console.log(chalk.yellow('💡 You are not logged in.'));
      return;
    }
    
    // Clear user data but keep the structure
    const email = this.config.user?.email;
    this.config = {};
    this.saveConfig();
    
    console.log(chalk.green('✅ Logged out successfully'));
    if (email) {
      console.log(chalk.gray(`Disconnected from ${email}`));
    }
  }
}

// CLI Commands
const cli = new EdPearCLI();

program
  .name('edpear')
  .description('EdPear CLI - AI-powered educational components')
  .version('1.0.0');

program
  .command('login')
  .description('Authenticate with EdPear')
  .action(() => cli.login());

program
  .command('generate-key')
  .description('Generate a new API key')
  .action(() => cli.generateKey());

program
  .command('status')
  .description('Show current status and API keys')
  .action(() => cli.status());

program
  .command('command-line')
  .description('Alias for login')
  .action(() => cli.login());

program
  .command('logout')
  .description('Logout from EdPear')
  .action(() => cli.logout());

program.parse();

