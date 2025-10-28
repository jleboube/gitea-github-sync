const express = require('express');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const winston = require('winston');
const axios = require('axios');

// Configure logger
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    }),
    new winston.transports.File({ 
      filename: '/app/data/sync-service.log',
      maxsize: 5242880, // 5MB
      maxFiles: 5
    })
  ]
});

const app = express();
app.use(express.json());

const config = {
  giteaUrl: process.env.GITEA_URL,
  giteaToken: process.env.GITEA_TOKEN,
  githubToken: process.env.GITHUB_TOKEN,
  syncThresholdBuilds: parseInt(process.env.SYNC_THRESHOLD_BUILDS) || 5,
  syncThresholdHours: parseInt(process.env.SYNC_THRESHOLD_HOURS) || 48,
  webhookSecret: process.env.WEBHOOK_SECRET,
  dataFile: '/app/data/sync-state.json',
  tmpDir: '/tmp/sync-repos'
};

// Ensure tmp directory exists
if (!fs.existsSync(config.tmpDir)) {
  fs.mkdirSync(config.tmpDir, { recursive: true });
}

// Load or initialize state
let state = {};
if (fs.existsSync(config.dataFile)) {
  try {
    state = JSON.parse(fs.readFileSync(config.dataFile, 'utf8'));
    logger.info('Loaded existing state', { repos: Object.keys(state).length });
  } catch (error) {
    logger.error('Error loading state file, starting fresh', { error: error.message });
    state = {};
  }
} else {
  logger.info('No existing state file, starting fresh');
}

function saveState() {
  try {
    fs.writeFileSync(config.dataFile, JSON.stringify(state, null, 2));
    logger.debug('State saved successfully');
  } catch (error) {
    logger.error('Error saving state', { error: error.message });
  }
}

// Verify webhook signature (if secret is configured)
function verifySignature(req, res, next) {
  if (!config.webhookSecret) {
    return next();
  }

  const signature = req.headers['x-gitea-signature'];
  if (!signature) {
    logger.warn('Missing webhook signature');
    return res.status(401).json({ error: 'Missing signature' });
  }

  const hmac = crypto.createHmac('sha256', config.webhookSecret);
  const digest = hmac.update(JSON.stringify(req.body)).digest('hex');

  if (signature !== digest) {
    logger.warn('Invalid webhook signature');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  next();
}

// Initialize repo state
function initRepoState(repoFullName, githubRepo = null) {
  if (!state[repoFullName]) {
    state[repoFullName] = {
      successfulBuilds: 0,
      totalPushes: 0,
      lastSync: null,
      lastPush: null,
      githubRepo: githubRepo || repoFullName, // Default to same name
      syncHistory: []
    };
    saveState();
    logger.info('Initialized new repo state', { repo: repoFullName });
  }
  return state[repoFullName];
}

// Webhook endpoint from Gitea
app.post('/webhook/:owner/:repo', verifySignature, async (req, res) => {
  const { owner, repo } = req.params;
  const repoFullName = `${owner}/${repo}`;
  const event = req.body;

  logger.info('Received webhook', { 
    repo: repoFullName, 
    ref: event.ref,
    event: req.headers['x-gitea-event']
  });

  try {
    // Initialize or get repo state
    const repoState = initRepoState(repoFullName, event.repository?.github_mirror);

    // Handle push events
    if (req.headers['x-gitea-event'] === 'push') {
      repoState.totalPushes++;
      repoState.lastPush = new Date().toISOString();

      // Only count main/master branch pushes as "builds"
      const mainBranches = ['refs/heads/main', 'refs/heads/master'];
      if (mainBranches.includes(event.ref)) {
        repoState.successfulBuilds++;
        logger.info('Build count incremented', { 
          repo: repoFullName, 
          count: repoState.successfulBuilds 
        });

        saveState();

        // Check if we should sync
        const shouldSync = await checkSyncConditions(repoFullName);
        
        if (shouldSync) {
          // Sync in background to avoid blocking webhook response
          syncToGithub(repoFullName, repoState.githubRepo)
            .then(() => {
              repoState.successfulBuilds = 0;
              repoState.lastSync = new Date().toISOString();
              repoState.syncHistory.push({
                timestamp: new Date().toISOString(),
                trigger: 'auto',
                success: true
              });
              // Keep only last 10 sync history entries
              if (repoState.syncHistory.length > 10) {
                repoState.syncHistory = repoState.syncHistory.slice(-10);
              }
              saveState();
            })
            .catch(error => {
              logger.error('Background sync failed', { 
                repo: repoFullName, 
                error: error.message 
              });
              repoState.syncHistory.push({
                timestamp: new Date().toISOString(),
                trigger: 'auto',
                success: false,
                error: error.message
              });
              saveState();
            });
        }
      }
    }

    res.status(200).json({ 
      message: 'Webhook processed',
      repo: repoFullName,
      builds: repoState.successfulBuilds,
      shouldSync: false // Will sync in background if needed
    });

  } catch (error) {
    logger.error('Error processing webhook', { 
      repo: repoFullName, 
      error: error.message 
    });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Manual sync endpoint
app.post('/sync/:owner/:repo', async (req, res) => {
  const { owner, repo } = req.params;
  const repoFullName = `${owner}/${repo}`;
  const { githubRepo } = req.body;

  logger.info('Manual sync requested', { repo: repoFullName });

  try {
    const repoState = initRepoState(repoFullName, githubRepo);
    
    await syncToGithub(repoFullName, repoState.githubRepo);
    
    repoState.successfulBuilds = 0;
    repoState.lastSync = new Date().toISOString();
    repoState.syncHistory.push({
      timestamp: new Date().toISOString(),
      trigger: 'manual',
      success: true
    });
    saveState();

    res.status(200).json({ 
      message: 'Sync completed successfully',
      repo: repoFullName,
      githubRepo: repoState.githubRepo
    });

  } catch (error) {
    logger.error('Manual sync failed', { 
      repo: repoFullName, 
      error: error.message 
    });
    
    if (state[repoFullName]) {
      state[repoFullName].syncHistory.push({
        timestamp: new Date().toISOString(),
        trigger: 'manual',
        success: false,
        error: error.message
      });
      saveState();
    }

    res.status(500).json({ 
      error: 'Sync failed',
      message: error.message
    });
  }
});

// Check sync conditions
async function checkSyncConditions(repoFullName) {
  const repoState = state[repoFullName];
  
  if (!repoState) {
    logger.warn('No state found for repo', { repo: repoFullName });
    return false;
  }

  // Check build count threshold
  if (repoState.successfulBuilds >= config.syncThresholdBuilds) {
    logger.info('Build threshold met', { 
      repo: repoFullName, 
      builds: repoState.successfulBuilds,
      threshold: config.syncThresholdBuilds
    });
    return true;
  }

  // Check time since last sync
  if (repoState.lastSync) {
    const hoursSinceSync = (Date.now() - new Date(repoState.lastSync)) / (1000 * 60 * 60);
    if (hoursSinceSync >= config.syncThresholdHours) {
      logger.info('Time threshold met', { 
        repo: repoFullName, 
        hoursSinceSync: hoursSinceSync.toFixed(2),
        threshold: config.syncThresholdHours
      });
      return true;
    }
  } else if (repoState.successfulBuilds > 0) {
    // Never synced before, do initial sync after first build
    logger.info('Initial sync condition met', { repo: repoFullName });
    return true;
  }

  logger.debug('Sync conditions not met', { 
    repo: repoFullName,
    builds: repoState.successfulBuilds,
    threshold: config.syncThresholdBuilds
  });

  return false;
}

// Sync repository to GitHub
async function syncToGithub(giteaRepo, githubRepo) {
  logger.info('Starting sync', { 
    from: giteaRepo, 
    to: githubRepo 
  });
  
  const timestamp = Date.now();
  const tmpRepoDir = path.join(config.tmpDir, `${giteaRepo.replace('/', '-')}-${timestamp}`);
  
  try {
    // Clone from Gitea with mirror
    logger.debug('Cloning from Gitea', { repo: giteaRepo });
    const giteaCloneUrl = `${config.giteaUrl}/${giteaRepo}.git`;
    
    execSync(`git clone --mirror ${giteaCloneUrl} ${tmpRepoDir}`, {
      env: { 
        ...process.env, 
        GIT_TERMINAL_PROMPT: '0',
        GIT_ASKPASS: 'echo',
        GIT_USERNAME: 'token',
        GIT_PASSWORD: config.giteaToken
      },
      stdio: 'pipe'
    });

    logger.debug('Cloned successfully', { repo: giteaRepo });

    // Check if GitHub repo exists, create if not
    await ensureGithubRepo(githubRepo);

    // Push to GitHub
    logger.debug('Pushing to GitHub', { repo: githubRepo });
    const githubPushUrl = `https://x-access-token:${config.githubToken}@github.com/${githubRepo}.git`;
    
    execSync(`git push --mirror ${githubPushUrl}`, {
      cwd: tmpRepoDir,
      env: { 
        ...process.env, 
        GIT_TERMINAL_PROMPT: '0'
      },
      stdio: 'pipe'
    });

    logger.info('Sync completed successfully', { 
      from: giteaRepo, 
      to: githubRepo 
    });
    
  } catch (error) {
    logger.error('Sync failed', { 
      from: giteaRepo, 
      to: githubRepo,
      error: error.message,
      stderr: error.stderr?.toString()
    });
    throw error;
  } finally {
    // Cleanup
    try {
      if (fs.existsSync(tmpRepoDir)) {
        execSync(`rm -rf ${tmpRepoDir}`);
        logger.debug('Cleaned up temp directory', { dir: tmpRepoDir });
      }
    } catch (cleanupError) {
      logger.warn('Error cleaning up temp directory', { 
        dir: tmpRepoDir, 
        error: cleanupError.message 
      });
    }
  }
}

// Ensure GitHub repository exists
async function ensureGithubRepo(githubRepo) {
  const [owner, repo] = githubRepo.split('/');
  
  try {
    // Check if repo exists
    const response = await axios.get(`https://api.github.com/repos/${githubRepo}`, {
      headers: {
        'Authorization': `token ${config.githubToken}`,
        'Accept': 'application/vnd.github.v3+json'
      },
      validateStatus: (status) => status === 200 || status === 404
    });

    if (response.status === 404) {
      logger.info('GitHub repo does not exist, creating', { repo: githubRepo });
      
      // Create repo
      await axios.post('https://api.github.com/user/repos', {
        name: repo,
        private: true, // Change to false if you want public repos
        auto_init: false
      }, {
        headers: {
          'Authorization': `token ${config.githubToken}`,
          'Accept': 'application/vnd.github.v3+json'
        }
      });

      logger.info('GitHub repo created', { repo: githubRepo });
    } else {
      logger.debug('GitHub repo exists', { repo: githubRepo });
    }
  } catch (error) {
    logger.error('Error ensuring GitHub repo exists', { 
      repo: githubRepo, 
      error: error.message 
    });
    throw error;
  }
}

// Get repo status
app.get('/status/:owner/:repo', (req, res) => {
  const { owner, repo } = req.params;
  const repoFullName = `${owner}/${repo}`;
  
  if (!state[repoFullName]) {
    return res.status(404).json({ error: 'Repository not found in state' });
  }

  const repoState = state[repoFullName];
  const hoursSinceSync = repoState.lastSync 
    ? ((Date.now() - new Date(repoState.lastSync)) / (1000 * 60 * 60)).toFixed(2)
    : null;

  res.json({
    repo: repoFullName,
    githubRepo: repoState.githubRepo,
    successfulBuilds: repoState.successfulBuilds,
    totalPushes: repoState.totalPushes,
    lastSync: repoState.lastSync,
    lastPush: repoState.lastPush,
    hoursSinceSync,
    syncHistory: repoState.syncHistory.slice(-5), // Last 5 syncs
    thresholds: {
      builds: config.syncThresholdBuilds,
      hours: config.syncThresholdHours
    }
  });
});

// List all tracked repos
app.get('/repos', (req, res) => {
  const repos = Object.keys(state).map(repoFullName => {
    const repoState = state[repoFullName];
    return {
      repo: repoFullName,
      githubRepo: repoState.githubRepo,
      successfulBuilds: repoState.successfulBuilds,
      lastSync: repoState.lastSync,
      lastPush: repoState.lastPush
    };
  });

  res.json({ 
    count: repos.length,
    repos 
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  const uptime = process.uptime();
  const repoCount = Object.keys(state).length;
  
  res.json({ 
    status: 'healthy',
    uptime: uptime.toFixed(0),
    repoCount,
    config: {
      syncThresholdBuilds: config.syncThresholdBuilds,
      syncThresholdHours: config.syncThresholdHours
    }
  });
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');
  saveState();
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down gracefully');
  saveState();
  process.exit(0);
});

const PORT = process.env.WEBHOOK_PORT || 3000;
app.listen(PORT, () => {
  logger.info('Gitea-GitHub sync service started', { 
    port: PORT,
    repoCount: Object.keys(state).length,
    thresholds: {
      builds: config.syncThresholdBuilds,
      hours: config.syncThresholdHours
    }
  });
});
```

