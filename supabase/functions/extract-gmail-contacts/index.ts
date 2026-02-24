import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const INTERNAL_DOMAINS = ['anzen.co.in', 'shubham.co.in', 'shubham.com'];
const INTERNAL_EMAILS = ['lunkad.v@gmail.com', 'sumathi.lunkad@gmail.com'];
const BATCH_SIZE = 15;

interface ExtractedContact {
  companyName: string;
  customerName: string;
  emailIds: string[];
  phone: string;
  mobile: string;
  website: string;
  address: string;
  source: string;
  confidence: number;
}

interface EmailData {
  messageId: string;
  email: string;
  name?: string;
  subject: string;
  body: string;
}

function isInternalEmail(email: string): boolean {
  const lowerEmail = email.toLowerCase();
  if (INTERNAL_EMAILS.some(internal => lowerEmail === internal.toLowerCase())) return true;
  const domain = email.split('@')[1]?.toLowerCase();
  return INTERNAL_DOMAINS.some(d => domain === d);
}

function isNoReply(email: string): boolean {
  return email.includes('noreply') || email.includes('no-reply') || email.includes('donotreply');
}

function isGenericDomain(domain: string): boolean {
  return ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'live.com', 'icloud.com'].includes(domain.toLowerCase());
}

async function extractContactsBatchWithAI(
  emails: EmailData[],
  openaiApiKey: string
): Promise<Map<string, Partial<ExtractedContact>>> {
  const results = new Map<string, Partial<ExtractedContact>>();

  const emailList = emails.map((e, i) =>
    `[${i + 1}] FROM: ${e.email} | NAME: ${e.name || 'N/A'} | SUBJECT: ${e.subject.substring(0, 80)} | BODY: ${e.body.substring(0, 600)}`
  ).join('\n\n');

  const prompt = `Extract company/contact info from these ${emails.length} emails. Return ONLY a JSON array with exactly ${emails.length} objects (one per email, in order).

Emails:
${emailList}

Rules:
- companyName: Extract from signature or domain. For .co.id add "PT " prefix if missing. Empty string if unclear or generic (gmail/yahoo/hotmail).
- customerName: From signature or From name.
- phone/mobile: From signature only.
- website: Company website from signature.
- confidence: 0.8-1.0 for clear company, 0.5-0.7 domain-derived, 0.0-0.4 unclear.
- NEVER use greeting text or email body content for company name.

Return JSON array (no markdown):
[{"companyName":"","customerName":"","phone":"","mobile":"","website":"","confidence":0.0}, ...]`;

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${openaiApiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-3.5-turbo',
        messages: [
          { role: 'system', content: 'You are a data extraction assistant. Return ONLY valid JSON arrays, no markdown.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.1,
        max_tokens: 200 * emails.length,
      }),
    });

    if (!response.ok) {
      console.error('OpenAI batch error:', response.status);
      return results;
    }

    const data = await response.json();
    let content = data.choices[0]?.message?.content?.trim() || '[]';
    content = content.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();

    const extracted = JSON.parse(content);
    if (!Array.isArray(extracted)) return results;

    for (let i = 0; i < emails.length; i++) {
      const item = extracted[i];
      if (!item) continue;

      const isValid = (name: string) => {
        if (!name || name.length < 3) return false;
        return !/^(dear|hi|hello|regards|thanks|best|sincerely|thank you|we|i |our|your|the |this|that|it |please|sorry)/i.test(name);
      };

      results.set(emails[i].messageId, {
        companyName: isValid(item.companyName) ? item.companyName : '',
        customerName: item.customerName || emails[i].name || emails[i].email.split('@')[0],
        phone: item.phone || '',
        mobile: item.mobile || '',
        website: item.website || '',
        address: item.address || '',
        confidence: Number(item.confidence) || 0.3,
        emailIds: [emails[i].email],
        source: 'Gmail',
      });
    }
  } catch (error) {
    console.error('Batch AI extraction error:', error);
  }

  return results;
}

function getEmailBody(message: any): string {
  let body = '';
  if (message.payload.body?.data) {
    body = atob(message.payload.body.data.replace(/-/g, '+').replace(/_/g, '/'));
  } else if (message.payload.parts) {
    for (const part of message.payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        body += atob(part.body.data.replace(/-/g, '+').replace(/_/g, '/'));
      }
    }
  }
  return body.substring(0, 800);
}

function extractFromHeader(headers: any[]): { email: string; name?: string } | null {
  const fromHeader = headers.find((h: any) => h.name.toLowerCase() === 'from');
  if (!fromHeader) return null;
  const nameEmail = /^(.+?)\s*<([^>]+)>/.exec(fromHeader.value);
  if (nameEmail) return { name: nameEmail[1].replace(/"/g, '').trim(), email: nameEmail[2].trim() };
  const emailOnly = /([^\s<>]+@[^\s<>]+)/.exec(fromHeader.value);
  if (emailOnly) return { email: emailOnly[1].trim() };
  return null;
}

function getSubject(headers: any[]): string {
  return headers.find((h: any) => h.name.toLowerCase() === 'subject')?.value || '';
}

async function fetchAllGmailMessages(
  accessToken: string,
  maxResults: number,
  supabaseClient: any,
  connectionId: string,
  userId: string
): Promise<any[]> {
  const { data: processedMessages } = await supabaseClient
    .from('gmail_processed_messages')
    .select('gmail_message_id')
    .eq('connection_id', connectionId)
    .eq('user_id', userId);

  const processedIds = new Set((processedMessages || []).map((m: any) => m.gmail_message_id));
  console.log(`Already processed: ${processedIds.size} messages`);

  const messages: any[] = [];
  let pageToken = '';
  let pagesFetched = 0;
  const MAX_PAGES = 50;

  while (messages.length < maxResults && pagesFetched < MAX_PAGES) {
    const listUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=100${pageToken ? `&pageToken=${pageToken}` : ''}`;
    const listResponse = await fetch(listUrl, {
      headers: { 'Authorization': `Bearer ${accessToken}` },
    });

    if (!listResponse.ok) throw new Error(`Gmail list error: ${listResponse.status}`);
    const listData = await listResponse.json();
    pagesFetched++;

    if (!listData.messages?.length) break;

    const newIds = listData.messages.filter((m: any) => !processedIds.has(m.id));

    const batchFetch = newIds.slice(0, maxResults - messages.length).map(async (msg: any) => {
      const detailResponse = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=full`,
        { headers: { 'Authorization': `Bearer ${accessToken}` } }
      );
      if (detailResponse.ok) return detailResponse.json();
      return null;
    });

    const fetched = await Promise.all(batchFetch);
    for (const msg of fetched) {
      if (msg) messages.push(msg);
    }

    if (!listData.nextPageToken || messages.length >= maxResults) break;
    pageToken = listData.nextPageToken;
  }

  console.log(`Fetched ${messages.length} new messages`);
  return messages;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const { access_token, max_emails = 2000, user_id, connection_id } = await req.json();

    if (!access_token || !user_id || !connection_id) {
      return new Response(
        JSON.stringify({ error: 'access_token, user_id, and connection_id are required', success: false }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const openaiApiKey = Deno.env.get('OPENAI_API_KEY');
    if (!openaiApiKey) {
      return new Response(
        JSON.stringify({ error: 'OpenAI API key not configured', success: false }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const safeMax = Math.min(max_emails, 5000);
    console.log(`Fetching up to ${safeMax} new emails...`);

    const messages = await fetchAllGmailMessages(access_token, safeMax, supabase, connection_id, user_id);

    if (messages.length === 0) {
      return new Response(
        JSON.stringify({
          success: true,
          total_emails_scanned: 0,
          total_contacts: 0,
          contacts: [],
          message: 'All emails already processed. No new emails found.'
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const emailsToProcess: EmailData[] = [];
    const skipIds: string[] = [];

    for (const message of messages) {
      const headers = message.payload?.headers || [];
      const from = extractFromHeader(headers);
      if (!from || isInternalEmail(from.email) || isNoReply(from.email)) {
        skipIds.push(message.id);
        continue;
      }
      emailsToProcess.push({
        messageId: message.id,
        email: from.email,
        name: from.name,
        subject: getSubject(headers),
        body: getEmailBody(message),
      });
    }

    console.log(`Skipped ${skipIds.length}, processing ${emailsToProcess.length} emails in batches of ${BATCH_SIZE}...`);

    const contactsMap = new Map<string, ExtractedContact>();
    const processedMessageIds: string[] = [...skipIds];

    for (let i = 0; i < emailsToProcess.length; i += BATCH_SIZE) {
      const batch = emailsToProcess.slice(i, i + BATCH_SIZE);
      const batchResults = await extractContactsBatchWithAI(batch, openaiApiKey);

      for (const emailData of batch) {
        const result = batchResults.get(emailData.messageId);
        const domain = emailData.email.split('@')[1] || '';

        if (result && result.confidence && result.confidence >= 0.5) {
          const companyKey = isGenericDomain(domain) ? emailData.email : domain;
          const existing = contactsMap.get(companyKey);

          if (existing) {
            if (!existing.emailIds.includes(emailData.email)) existing.emailIds.push(emailData.email);
            existing.confidence = Math.max(existing.confidence, result.confidence);
            if (!existing.companyName && result.companyName) existing.companyName = result.companyName;
          } else {
            contactsMap.set(companyKey, {
              companyName: result.companyName || '',
              customerName: result.customerName || emailData.name || emailData.email.split('@')[0],
              emailIds: [emailData.email],
              phone: result.phone || '',
              mobile: result.mobile || '',
              website: result.website || '',
              address: result.address || '',
              source: 'Gmail',
              confidence: result.confidence,
            });
          }

          await supabase.from('gmail_processed_messages').insert({
            user_id: user_id,
            connection_id: connection_id,
            gmail_message_id: emailData.messageId,
            contacts_extracted: 1,
            extraction_data: result
          }).then(() => {});
        } else {
          processedMessageIds.push(emailData.messageId);
        }
      }

      console.log(`Batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(emailsToProcess.length / BATCH_SIZE)} done. Contacts so far: ${contactsMap.size}`);
    }

    if (processedMessageIds.length > 0) {
      const CHUNK = 100;
      for (let i = 0; i < processedMessageIds.length; i += CHUNK) {
        await supabase.from('gmail_processed_messages').insert(
          processedMessageIds.slice(i, i + CHUNK).map(msgId => ({
            user_id: user_id,
            connection_id: connection_id,
            gmail_message_id: msgId,
            contacts_extracted: 0,
            extraction_data: null
          }))
        );
      }
    }

    const contacts = Array.from(contactsMap.values())
      .filter(c => c.companyName && c.companyName.length > 2 && c.confidence >= 0.5)
      .map(c => ({ ...c, emailIds: c.emailIds.join('; ') }));

    console.log(`Done. ${contacts.length} contacts from ${messages.length} emails`);

    return new Response(
      JSON.stringify({
        success: true,
        total_emails_scanned: messages.length,
        total_contacts: contacts.length,
        contacts,
        message: `Processed ${messages.length} emails and extracted ${contacts.length} contacts`
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error: any) {
    console.error('Error in extract-gmail-contacts:', error);
    return new Response(
      JSON.stringify({ error: error.message || 'An error occurred', success: false }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
