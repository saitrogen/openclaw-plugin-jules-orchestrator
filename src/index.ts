import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';

enum TaskStatus {
  NEW = 'NEW',
  QUEUED = 'QUEUED',
  PLANNING = 'PLANNING',
  WAITING_FOR_PLAN_APPROVAL = 'WAITING_FOR_PLAN_APPROVAL',
  RUNNING = 'RUNNING',
  WAITING_FOR_DIFF_APPROVAL = 'WAITING_FOR_DIFF_APPROVAL',
  READY_FOR_PR = 'READY_FOR_PR',
  PR_CREATED = 'PR_CREATED',
  MERGED = 'MERGED',
  CANCELLED = 'CANCELLED',
  FAILED = 'FAILED',
}

interface Task {
  id: string;
  title: string;
  description: string;
  repo: string;
  status: TaskStatus;
  julesSessionId?: string;
  githubPrUrl?: string;
  createdAt: string;
  updatedAt: string;
  error?: string;
}

interface Config {
  julesApiKey: string;
  githubToken: string;
  defaultRepo: string;
}

class TaskManager {
  private dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
  }

  private getFilePath(id: string): string {
    return path.join(this.dataDir, `${id}.json`);
  }

  async saveTask(task: Task): Promise<void> {
    const filePath = this.getFilePath(task.id);
    await fs.promises.writeFile(filePath, JSON.stringify(task, null, 2));
  }

  async getTask(id: string): Promise<Task | null> {
    const filePath = this.getFilePath(id);
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const data = await fs.promises.readFile(filePath, 'utf-8');
    return JSON.parse(data) as Task;
  }

  async listTasks(): Promise<Task[]> {
    const files = await fs.promises.readdir(this.dataDir);
    const tasks: Task[] = [];
    for (const file of files) {
      if (file.endsWith('.json')) {
        const filePath = path.join(this.dataDir, file);
        const data = await fs.promises.readFile(filePath, 'utf-8');
        try {
          tasks.push(JSON.parse(data) as Task);
        } catch (e) {
          console.error(`Failed to parse task file: ${file}`, e);
        }
      }
    }
    return tasks;
  }

  async updateTask(id: string, updates: Partial<Task>): Promise<Task> {
    const task = await this.getTask(id);
    if (!task) {
      throw new Error(`Task not found: ${id}`);
    }
    const updatedTask = { ...task, ...updates, updatedAt: new Date().toISOString() };
    await this.saveTask(updatedTask);
    return updatedTask;
  }
}

class JulesClient {
  private apiKey: string;
  private baseUrl = 'https://jules.googleapis.com/v1alpha';

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async createSession(task: Task): Promise<string> {
    // Mock implementation for now, assuming similar structure to real API
    // In a real scenario, this would POST to /sessions
    try {
      const response = await axios.post(`${this.baseUrl}/sessions?key=${this.apiKey}`, {
        Repo: task.repo,
        Description: task.description,
      });
      return response.data.sessionId; // Assuming response structure
    } catch (error) {
      console.error('Error creating Jules session:', error);
      throw error;
    }
  }

  async getSessionStatus(sessionId: string): Promise<any> {
    try {
      const response = await axios.get(`${this.baseUrl}/sessions/${sessionId}?key=${this.apiKey}`);
      return response.data;
    } catch (error) {
       console.error('Error fetching Jules session status:', error);
       throw error;
    }
  }

  async approvePlan(sessionId: string): Promise<void> {
      await axios.post(`${this.baseUrl}/sessions/${sessionId}:approvePlan?key=${this.apiKey}`);
  }

  async approveDiff(sessionId: string): Promise<void> {
      await axios.post(`${this.baseUrl}/sessions/${sessionId}:approveDiff?key=${this.apiKey}`);
  }

    async cancelSession(sessionId: string): Promise<void> {
      await axios.post(`${this.baseUrl}/sessions/${sessionId}:cancel?key=${this.apiKey}`);
  }
}

class GithubClient {
    private token: string;
    private baseUrl = 'https://api.github.com';

    constructor(token: string) {
        this.token = token;
    }

    private get headers() {
        return {
            Authorization: `Bearer ${this.token}`,
            Accept: 'application/vnd.github.v3+json',
        };
    }

    async createPr(repo: string, branch: string, title: string, body: string, base: string = 'main'): Promise<string> {
        const [owner, repoName] = repo.split('/');
        const response = await axios.post(`${this.baseUrl}/repos/${owner}/${repoName}/pulls`, {
            title,
            body,
            head: branch,
            base,
        }, { headers: this.headers });
        return response.data.html_url;
    }
}

export const init = async (context: any) => {
  const config = context.config as Config;
  if (!config.julesApiKey || !config.githubToken) {
    console.error("Missing required configuration: julesApiKey or githubToken");
    return;
  }

  const dataDir = path.join(context.dataDir || './data', 'tasks');
  const taskManager = new TaskManager(dataDir);
  const julesClient = new JulesClient(config.julesApiKey);
  const githubClient = new GithubClient(config.githubToken);

  // Background service to poll tasks
  context.api.registerService({
    id: 'jules-poller',
    interval: 10000, // 10 seconds
    run: async () => {
      const tasks = await taskManager.listTasks();
      for (const task of tasks) {
        if (task.status === TaskStatus.RUNNING || task.status === TaskStatus.PLANNING || task.status === TaskStatus.QUEUED) {
             if (task.julesSessionId) {
                 try {
                     const status = await julesClient.getSessionStatus(task.julesSessionId);
                     // Map Jules status to TaskStatus
                     // This is hypothetical mapping based on typical agent states
                     let newStatus: TaskStatus = task.status;
                     if (status.state === 'WAITING_FOR_USER_PLAN_APPROVAL') {
                         newStatus = TaskStatus.WAITING_FOR_PLAN_APPROVAL;
                     } else if (status.state === 'WAITING_FOR_USER_DIFF_APPROVAL') {
                         newStatus = TaskStatus.WAITING_FOR_DIFF_APPROVAL;
                     } else if (status.state === 'DONE') {
                         newStatus = TaskStatus.READY_FOR_PR;
                     } else if (status.state === 'FAILED' || status.state === 'ERROR') {
                         newStatus = TaskStatus.FAILED;
                     }
                     
                     if (newStatus !== task.status) {
                         await taskManager.updateTask(task.id, { status: newStatus });
                     }
                 } catch (e) {
                     console.error(`Error polling task ${task.id}:`, e);
                 }
             }
        }
      }
    }
  });

  // Gateway methods
  context.api.registerGatewayMethod('jules-orchestrator.listTasks', async () => {
    return await taskManager.listTasks();
  });

  context.api.registerGatewayMethod('jules-orchestrator.getTask', async ({ id }: { id: string }) => {
    return await taskManager.getTask(id);
  });

  context.api.registerGatewayMethod('jules-orchestrator.createTask', async (params: { title: string, description: string, repo?: string }) => {
    const id = Math.random().toString(36).substring(7);
    const task: Task = {
      id,
      title: params.title,
      description: params.description,
      repo: params.repo || config.defaultRepo,
      status: TaskStatus.NEW,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await taskManager.saveTask(task);
    
    // Start Jules session immediately if possible
    try {
        const sessionId = await julesClient.createSession(task);
        return await taskManager.updateTask(id, { julesSessionId: sessionId, status: TaskStatus.PLANNING });
    } catch (e: any) {
        return await taskManager.updateTask(id, { status: TaskStatus.FAILED, error: e.message });
    }
  });

  context.api.registerGatewayMethod('jules-orchestrator.approveTask', async ({ id }: { id: string }) => {
      const task = await taskManager.getTask(id);
      if (!task || !task.julesSessionId) throw new Error("Task not found or no session");

      if (task.status === TaskStatus.WAITING_FOR_PLAN_APPROVAL) {
          await julesClient.approvePlan(task.julesSessionId);
          await taskManager.updateTask(id, { status: TaskStatus.RUNNING });
      } else if (task.status === TaskStatus.WAITING_FOR_DIFF_APPROVAL) {
          await julesClient.approveDiff(task.julesSessionId);
          await taskManager.updateTask(id, { status: TaskStatus.READY_FOR_PR });
      } else {
          throw new Error("Task is not in a state waiting for approval");
      }
      return await taskManager.getTask(id);
  });

    context.api.registerGatewayMethod('jules-orchestrator.cancelTask', async ({ id }: { id: string }) => {
      const task = await taskManager.getTask(id);
      if (!task) throw new Error("Task not found");
      
      if (task.julesSessionId) {
          try {
            await julesClient.cancelSession(task.julesSessionId);
          } catch (e) {
              console.warn("Failed to cancel Jules session", e);
          }
      }
      await taskManager.updateTask(id, { status: TaskStatus.CANCELLED });
      return await taskManager.getTask(id);
  });

  context.api.registerGatewayMethod('jules-orchestrator.createPrForTask', async ({ id, branch, title, body }: { id: string, branch: string, title?: string, body?: string }) => {
      const task = await taskManager.getTask(id);
      if (!task) throw new Error("Task not found");
      if (task.status !== TaskStatus.READY_FOR_PR) throw new Error("Task is not ready for PR");

      const prUrl = await githubClient.createPr(
          task.repo,
          branch, // Assuming Jules pushed to this branch
          title || task.title,
          body || task.description
      );

      await taskManager.updateTask(id, { status: TaskStatus.PR_CREATED, githubPrUrl: prUrl });
      return await taskManager.getTask(id);
  });

  console.log("Jules Orchestrator Plugin initialized successfully");
};
