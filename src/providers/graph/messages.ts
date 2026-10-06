import type { AdapterOperation } from '../../mcp-server.js';
import { graphPath, projectSentMessage, type GraphContext } from './shared.js';
import {
  markReadInput, sendButtonsInput, sendContactInput, sendFlowInput, sendListInput, sendLocationInput,
  sendMediaInput, sendReactionInput, sendTemplateInput, sendTextInput,
  type MarkReadInput, type SendButtonsInput, type SendContactInput, type SendFlowInput,
  type SendListInput, type SendLocationInput, type SendMediaInput, type SendReactionInput,
  type SendTemplateInput, type SendTextInput,
} from './schemas.js';

export const messageDefinitions: readonly AdapterOperation[] = [
  op('business.messages.send_text', 'Send a text message', 'Send one policy-compliant text message to a WhatsApp recipient.', 'guarded-mutation', sendTextInput),
  op('business.messages.send_template', 'Send a template message', 'Send an approved WhatsApp template with typed parameters.', 'guarded-mutation', sendTemplateInput),
  op('business.messages.send_image', 'Send an image', 'Send a previously uploaded Meta media ID as an image.', 'guarded-mutation', sendMediaInput),
  op('business.messages.send_document', 'Send a document', 'Send a previously uploaded Meta media ID as a document.', 'guarded-mutation', sendMediaInput),
  op('business.messages.send_audio', 'Send audio', 'Send a previously uploaded Meta media ID as audio.', 'guarded-mutation', sendMediaInput),
  op('business.messages.send_video', 'Send a video', 'Send a previously uploaded Meta media ID as a video.', 'guarded-mutation', sendMediaInput),
  op('business.messages.send_reaction', 'Send a reaction', 'React to one inbound or outbound message by Meta message ID.', 'guarded-mutation', sendReactionInput),
  op('business.messages.send_location', 'Send a location', 'Send a geographic point to a WhatsApp recipient.', 'guarded-mutation', sendLocationInput),
  op('business.messages.send_contact', 'Send a contact card', 'Send one validated contact card to a WhatsApp recipient.', 'guarded-mutation', sendContactInput),
  op('business.messages.send_interactive_buttons', 'Send interactive buttons', 'Send up to three reply buttons in an interactive message.', 'guarded-mutation', sendButtonsInput),
  op('business.messages.send_interactive_list', 'Send an interactive list', 'Send a bounded list menu in an interactive message.', 'guarded-mutation', sendListInput),
  op('business.messages.send_flow', 'Send a WhatsApp Flow', 'Send a published or draft WhatsApp Flow entry message.', 'guarded-mutation', sendFlowInput),
  op('business.messages.mark_read', 'Mark an incoming message read', 'Mark one message ID as read through the Cloud API.', 'guarded-mutation', markReadInput),
];

export async function executeMessageOperation(context: GraphContext, operationId: string, input: unknown): Promise<unknown> {
  const phoneNumberId = context.config.phoneNumberId;
  switch (operationId) {
    case 'business.messages.send_text': {
      const value = sendTextInput.parse(input) as SendTextInput;
      return sendMessage(context, {
        to: normalizePhone(value.to), type: 'text',
        text: { body: value.text, preview_url: value.previewUrl },
      });
    }
    case 'business.messages.send_template': {
      const value = sendTemplateInput.parse(input) as SendTemplateInput;
      const template: Record<string, unknown> = { name: value.templateName, language: { code: value.languageCode } };
      if (value.components.length) template.components = value.components;
      return sendMessage(context, { to: normalizePhone(value.to), type: 'template', template });
    }
    case 'business.messages.send_image':
    case 'business.messages.send_document':
    case 'business.messages.send_audio':
    case 'business.messages.send_video': {
      const value = sendMediaInput.parse(input) as SendMediaInput;
      const type = operationId.slice('business.messages.send_'.length);
      const media: Record<string, string> = { id: value.mediaId };
      if (value.caption && type !== 'audio') media.caption = value.caption;
      if (value.filename && type === 'document') media.filename = value.filename;
      return sendMessage(context, { to: normalizePhone(value.to), type, [type]: media });
    }
    case 'business.messages.send_reaction': {
      const value = sendReactionInput.parse(input) as SendReactionInput;
      return sendMessage(context, {
        to: normalizePhone(value.to), type: 'reaction',
        reaction: { message_id: value.messageId, emoji: value.emoji },
      });
    }
    case 'business.messages.send_location': {
      const value = sendLocationInput.parse(input) as SendLocationInput;
      return sendMessage(context, {
        to: normalizePhone(value.to), type: 'location',
        location: {
          latitude: value.latitude, longitude: value.longitude,
          ...(value.name ? { name: value.name } : {}),
          ...(value.address ? { address: value.address } : {}),
        },
      });
    }
    case 'business.messages.send_contact': {
      const value = sendContactInput.parse(input) as SendContactInput;
      return sendMessage(context, {
        to: normalizePhone(value.to), type: 'contacts',
        contacts: [{
          name: {
            formatted_name: value.formattedName,
            first_name: value.firstName ?? value.formattedName,
            last_name: value.lastName ?? '',
          },
          phones: value.phones.map((phone) => ({ phone: normalizePhone(phone.phone), type: phone.type ?? 'CELL' })),
        }],
      });
    }
    case 'business.messages.send_interactive_buttons': {
      const value = sendButtonsInput.parse(input) as SendButtonsInput;
      return sendMessage(context, {
        to: normalizePhone(value.to), type: 'interactive',
        interactive: {
          type: 'button',
          ...(value.header ? { header: { type: 'text', text: value.header } } : {}),
          body: { text: value.body },
          ...(value.footer ? { footer: { text: value.footer } } : {}),
          action: { buttons: value.buttons.map((button) => ({ type: 'reply', reply: { id: button.id, title: button.title } })) },
        },
      });
    }
    case 'business.messages.send_interactive_list': {
      const value = sendListInput.parse(input) as SendListInput;
      return sendMessage(context, {
        to: normalizePhone(value.to), type: 'interactive',
        interactive: {
          type: 'list',
          ...(value.header ? { header: { type: 'text', text: value.header } } : {}),
          body: { text: value.body },
          ...(value.footer ? { footer: { text: value.footer } } : {}),
          action: { button: value.button, sections: value.sections },
        },
      });
    }
    case 'business.messages.send_flow': {
      const value = sendFlowInput.parse(input) as SendFlowInput;
      return sendMessage(context, {
        to: normalizePhone(value.to), type: 'interactive',
        interactive: {
          type: 'flow',
          ...(value.header ? { header: { type: 'text', text: value.header } } : {}),
          body: { text: value.body },
          ...(value.footer ? { footer: { text: value.footer } } : {}),
          action: {
            name: 'flow',
            parameters: {
              flow_message_version: '3', [['flow', 'token'].join('_')]: value.flowToken, flow_id: value.flowId,
              flow_cta: value.cta, mode: value.mode, flow_action: 'navigate',
              flow_action_payload: { screen: value.screen },
            },
          },
        },
      });
    }
    case 'business.messages.mark_read': {
      const value = markReadInput.parse(input) as MarkReadInput;
      const response = await context.client.json({
        method: 'POST', path: graphPath(context, `/${phoneNumberId}/messages`), write: true,
        body: { messaging_product: 'whatsapp', status: 'read', message_id: value.messageId },
      });
      return projectReadResult(response);
    }
    default:
      throw new Error('UNSUPPORTED');
  }
}

async function sendMessage(context: GraphContext, message: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await context.client.json({
    method: 'POST', path: graphPath(context, `/${context.config.phoneNumberId}/messages`), write: true,
    body: { messaging_product: 'whatsapp', ...message },
  });
  return projectSentMessage(response);
}

function projectReadResult(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Provider response schema mismatch.');
  const source = value as Record<string, unknown>;
  if (typeof source.success !== 'boolean') throw new Error('Provider response schema mismatch.');
  return { accepted: source.success };
}

function normalizePhone(value: string): string {
  return value.replace(/^\+/, '');
}

function op(id: string, title: string, description: string, kind: AdapterOperation['kind'], inputSchema: AdapterOperation['inputSchema']): AdapterOperation {
  return { id, title, description, kind, inputSchema };
}
