import cors from "cors";
import "dotenv/config";
import express from "express";
import { apiKey, serverClient } from "./serverClient";
import { createAgent } from "./agents/createAgent";
import { AgentPlatform, AIAgent } from "./agents/types";

const app = express();
app.use(express.json());
app.use(cors({ origin: "*" }));

// Track active AI agents by channel_id
const activeAgents = new Map<string, AIAgent>();

app.get("/", (req, res) => {
  res.json({
    message: "AI writing Assistant server is running",
    apiKey: apiKey,
  });
});

app.post("/token", async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) {
      res.status(400).json({ error: "userId is required" });
      return;
    }

    // Generate token for the user (local JWT signing, doesn't need API call)
    const token = serverClient.createToken(userId);

    // Upsert user in Stream Chat (non-blocking, don't fail if this errors)
    serverClient.upsertUser({ id: userId }).catch((err: any) => {
      console.warn(
        "Warning: Failed to upsert user, but token was generated:",
        err.message,
      );
    });

    res.json({ token });
  } catch (error) {
    console.error("Error generating token:", error);
    res.status(500).json({ error: "Failed to generate token" });
  }
});

// Start AI agent for a channel
app.post("/start-ai-agent", async (req, res) => {
  try {
    const { channel_id, channel_type = "messaging" } = req.body;

    if (!channel_id) {
      res.status(400).json({ reason: "channel_id is required" });
      return;
    }

    // Check if agent already exists for this channel
    if (activeAgents.has(channel_id)) {
      res.json({ message: "Agent already running for this channel" });
      return;
    }

    const agentUserId = `ai-assistant-${channel_id}`;

    // Upsert the AI bot user
    await serverClient.upsertUser({
      id: agentUserId,
      name: "AI Writing Assistant",
      role: "admin",
      image: "https://api.dicebear.com/9.x/bottts/svg?seed=ai-assistant",
    });

    // Add the AI user to the channel
    const channel = serverClient.channel(channel_type, channel_id);
    await channel.addMembers([agentUserId]);

    // Create and initialize the agent
    const agent = await createAgent(
      agentUserId,
      AgentPlatform.OPENAI,
      channel_type,
      channel_id,
    );
    await agent.init();

    activeAgents.set(channel_id, agent);

    console.log(`AI agent started for channel: ${channel_id}`);
    res.json({ message: "AI agent started successfully" });
  } catch (error: any) {
    console.error("Error starting AI agent:", error);
    res
      .status(500)
      .json({ reason: error.message || "Failed to start AI agent" });
  }
});

// Stop AI agent for a channel
app.post("/stop-ai-agent", async (req, res) => {
  try {
    const { channel_id } = req.body;

    if (!channel_id) {
      res.status(400).json({ reason: "channel_id is required" });
      return;
    }

    const agent = activeAgents.get(channel_id);
    if (!agent) {
      res.json({ message: "No agent running for this channel" });
      return;
    }

    await agent.dispose();
    activeAgents.delete(channel_id);

    console.log(`AI agent stopped for channel: ${channel_id}`);
    res.json({ message: "AI agent stopped successfully" });
  } catch (error: any) {
    console.error("Error stopping AI agent:", error);
    res
      .status(500)
      .json({ reason: error.message || "Failed to stop AI agent" });
  }
});

// Check AI agent status for a channel
app.get("/agent-status", (req, res) => {
  const channel_id = req.query.channel_id as string;

  if (!channel_id) {
    res.status(400).json({ reason: "channel_id is required" });
    return;
  }

  const isActive = activeAgents.has(channel_id);
  res.json({ status: isActive ? "connected" : "disconnected" });
});

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`Server is running at http://localhost:${port}`);
});
