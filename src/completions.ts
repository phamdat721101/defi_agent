import OpenAI from "openai";

import { Character } from "./characters";
import { logger } from "./logger";
import {
  IMAGE_GENERATION_PROMPT_MS2,
  REPLY_GUY_PROMPT,
  REPLY_GUY_PROMPT_SHORT,
  PROMPT_CHAT_MODE,
  TOPIC_PROMPT,
  WAS_PROMPT_BANNED,
} from "./prompts";

export const openai = new OpenAI({
  baseURL: process.env["LLM_PROVIDER_URL"] || "",
  apiKey: process.env["LLM_PROVIDER_API_KEY"] || "",
});

const MAX_OUTPUT_TOKENS = 70;

interface PromptContext extends Record<string, string> {
  agentName: string;
  username: string;
  bio: string;
  lore: string;
  postDirections: string;
  originalPost: string;
  knowledge: string;
  chatModeRules: string;
  recentHistory: string;
}

const generatePrompt = (
  context: PromptContext,
  isChatMode: boolean,
  inputLength: number,
) => {
  if (isChatMode) {
    return context.knowledge
      ? replaceTemplateVariables(
          `# Knowledge\n{{knowledge}}\n\n${PROMPT_CHAT_MODE}`,
          context,
        )
      : replaceTemplateVariables(PROMPT_CHAT_MODE, context);
  }

  const basePrompt =
    inputLength <= 20 ? REPLY_GUY_PROMPT_SHORT : REPLY_GUY_PROMPT;

  return context.knowledge
    ? replaceTemplateVariables(
        `# Knowledge\n{{knowledge}}\n\n${basePrompt}`,
        context,
      )
    : replaceTemplateVariables(basePrompt, context);
};

export async function generateImagePromptForCharacter(
  prompt: string,
  character: Character,
): Promise<string> {
  logger.info("Generating image prompt for character:", character.agentName);

  let imagePrompt;
  switch (character.imageGenerationBehavior?.provider) {
    case "ms2":
      imagePrompt = replaceTemplateVariables(IMAGE_GENERATION_PROMPT_MS2, {
        agentName: character.agentName,
        bio: character.bio.join("\n"),
        lore: character.lore.join("\n"),
        postDirections: character.postDirections.join("\n"),
        knowledge: character.knowledge || "",
        originalPost: prompt,
        username: character.username,
      });
      break;
    default:
      throw new Error(
        `Unsupported image provider: ${character.imageGenerationBehavior?.provider}`,
      );
  }

  try {
    const completion = await openai.chat.completions.create({
      model:
        character.imageGenerationBehavior?.imageGenerationPromptModel ||
        character.model,
      messages: [{ role: "user", content: imagePrompt }],
      max_tokens: MAX_OUTPUT_TOKENS,
      temperature: character.temperature,
    });

    if (!completion.choices[0]?.message?.content) {
      throw new Error("No completion content received from API");
    }

    return completion.choices[0].message.content;
  } catch (error) {
    logger.error("Error generating image prompt:", error);
    throw error;
  }
}

const generateCompletionForCharacter = async (
  prompt: string,
  character: Character,
  isChatMode: boolean = false,
  userPrompt?: string,
) => {
  let model = character.model;
  if (isChatMode) {
    model = character.postingBehavior.chatModeModel || character.model;
  }
  // TODO: change this once we use userPrompt everywhere
  if (userPrompt) {
    const completion = await openai.chat.completions.create({
      model: model,
      messages: [
        { role: "system", content: prompt },
        { role: "user", content: userPrompt },
      ],
      max_tokens: MAX_OUTPUT_TOKENS,
      temperature: character.temperature,
    });

    if (!completion.choices[0]?.message?.content) {
      throw new Error("No completion content received from API");
    }

    return completion.choices[0].message.content;
  }

  const completion = await openai.chat.completions.create({
    model: model,
    messages: [{ role: "user", content: prompt }],
    max_tokens: MAX_OUTPUT_TOKENS,
    temperature: character.temperature,
  });

  if (!completion.choices[0]?.message?.content) {
    throw new Error("No completion content received from API");
  }

  return completion.choices[0].message.content;
};

export const handleBannedAndLengthRetries = async (
  prompt: string,
  reply: string,
  character: Character,
  maxLength: number = 280,
  banThreshold: number = 3,
) => {
  let currentReply = reply;
  let banCount = 0;
  let wasBanned = await checkIfPromptWasBanned(currentReply, character);

  while (wasBanned || currentReply.length > maxLength) {
    if (wasBanned) {
      banCount++;
      logger.info(`The prompt was banned! Attempt ${banCount}/${banThreshold}`);

      // Use fallback model after threshold attempts
      if (banCount >= banThreshold && character.fallbackModel) {
        logger.info("Switching to fallback model:", character.fallbackModel);
        const originalModel = character.model;
        character.model = character.fallbackModel;
        currentReply = await generateCompletionForCharacter(prompt, character);
        character.model = originalModel; // Restore original model
        break;
      }
    } else {
      logger.info(`The content was too long (>${maxLength})! Going again.`);
    }

    currentReply = await generateCompletionForCharacter(prompt, character);
    wasBanned = await checkIfPromptWasBanned(currentReply, character);
  }

  return currentReply;
};

// Rules:
// if inputTweet.length <= 20, use REPLY_GUY_PROMPT_SHORT
// if character.removePeriods, then remove periods
// if character.onlyKeepFirstSentence, then only keep first sentence
export const generateReply = async (
  inputMessage: string,
  character: Character,
  isChatMode: boolean = false,
  recentHistory?: string,
) => {
  try {
    const context = {
      agentName: character.agentName,
      username: character.username,
      bio: character.bio.join("\n"),
      lore: character.lore.join("\n"),
      postDirections: character.postDirections.join("\n"),
      originalPost: inputMessage,
      knowledge: character.knowledge || "",
      chatModeRules: character.postingBehavior.chatModeRules?.join("\n") || "",
      recentHistory: recentHistory || "",
    };

    const prompt = generatePrompt(context, isChatMode, inputMessage.length);

    let reply = await generateCompletionForCharacter(
      prompt,
      character,
      isChatMode,
      inputMessage,
    );

    // Add ban/length handling
    if (!isChatMode) {
      reply = await handleBannedAndLengthRetries(
        prompt,
        reply,
        character,
        280,
        3,
      );
    }

    reply = formatReply(reply, character);
    return { prompt, reply };
  } catch (error) {
    console.error("Error generating reply:", error);
    throw error;
  }
};

export const generateTopicPost = async (
  character: Character,
  recentHistory: string,
) => {
  const topic = character
    .topics!.sort(() => Math.random() - 0.5)
    .slice(0, 1)[0];
  const adjective = character
    .adjectives!.sort(() => Math.random() - 0.5)
    .slice(0, 1)[0];
  const context = {
    agentName: character.agentName,
    username: character.username,
    bio: character.bio.join("\n"),
    lore: character.lore.join("\n"),
    postDirections: character.postDirections.join("\n"),
    recentHistory: recentHistory || "",
  };

  const userPrompt = `Generate a post that is ${adjective} about ${topic}`;

  let prompt = replaceTemplateVariables(TOPIC_PROMPT, context);
  let reply = await generateCompletionForCharacter(
    prompt,
    character,
    false,
    userPrompt,
  );

  reply = await handleBannedAndLengthRetries(prompt, reply, character, 280, 3);
  reply = reply.replace(/\\n/g, "\n");

  const topicPostLog = `<b>${character.username}, topic: ${topic}, adjective: ${adjective}</b>:\n\n${reply}`;
  logger.info(topicPostLog);
  return { prompt, reply };
};

const checkIfPromptWasBanned = async (reply: string, character: Character) => {
  const context = {
    agentName: character.agentName,
    username: character.username,
    reply,
  };
  const banCheckPrompt = replaceTemplateVariables(WAS_PROMPT_BANNED, context);
  const result = await generateCompletionForCharacter(
    banCheckPrompt,
    character,
  );
  return result.trim().toUpperCase() === "YES";
};

const formatReply = (reply: string, character: Character) => {
  let formattedReply = reply.replace(/\\n/g, "\n");

  if (character.postingBehavior.removePeriods) {
    formattedReply = formattedReply.replace(/\./g, "");
  }

  if (character.postingBehavior.onlyKeepFirstSentence) {
    formattedReply = formattedReply.split("\n")[0];
  }

  logger.debug(`Formatted reply: ${formattedReply}`);

  return formattedReply;
};

function replaceTemplateVariables(
  template: string,
  variables: Record<string, string>,
) {
  return template.replace(/{{(\w+)}}/g, (_, key) => variables[key] || "");
}
