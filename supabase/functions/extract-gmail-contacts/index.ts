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
    `[${i + 1}] FROM: ${e.email} | NAME: ${e.name || 'N/A'} | SUBJECT: ${e.subject.substring(0, 80)} | BODY_SNIPPET: ${e.body.substring(0, 700)}`
  ).join('\n\n---\n\n');

  const prompt = `You are extracting business contact info from ${emails.length} emails. Return ONLY a JSON array with exactly ${emails.length} objects (one per email, in order).

Emails:
${emailList}

Rules:
- companyName: Extract from email signature, domain, or company letterhead. For Indonesian domains (.co.id, .id) add "PT " prefix if missing and not already there. If domain is gmail/yahoo/hotmail/outlook but signature has company name, use that company name. Leave empty string ONLY if truly no company info found anywhere.
- customerName: The real person's name from the signature or "From" name. NOT greetings. NOT "Dear Sir".
- phone: Landline phone from signature (e.g. 021-xxx, +62-21-xxx). Empty if not found.
- mobile: Mobile/cell phone from signature (e.g. 08xx, +62-8xx, WhatsApp numbers). Empty if not found.
- website: Company website URL from signature. Empty if not found.
- confidence: 0.9 if company name clearly in signature; 0.7 if derived from corporate domain; 0.5 if gmail/yahoo but has real name; 0.3 if completely unclear.

CRITICAL:
- DO NOT use greeting text (Dear, Hi, Hello) as customerName
- DO NOT use email body paragraphs as company name
- For gmail/yahoo users who sign with their real name and company, EXTRACT that company name
- Return valid JSON array only, no markdown, no explanation

Return format (${emails.length} objects):
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
          { role: 'system', content: 'You are a data extraction assistant. Return ONLY valid JSON arrays, no markdown, no explanation.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.1,
        max_tokens: 250 * emails.length,
      }),
    });

    if (!response.ok) {
      console.error('OpenAI batch error:', response.status, await response.text());
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

      const isValidName = (name: string) => {
        if (!name || name.length < 2) return false;
        return !/^(dear|hi|hello|regards|thanks|best|sincerely|thank you|we |i |our |your |the |this |that |it |please|sorry|greetings)/i.test(name.trim());
      };

      results.set(emails[i].messageId, {
        companyName: isValidName(item.companyName) ? item.companyName.trim() : '',
        customerName: isValidName(item.customerName) ? item.customerName.trim() : (emails[i].name || emails[i].email.split('@')[0]),
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
      } else if (part.parts) {
        for (const subpart of part.parts) {
          if (subpart.mimeType === 'text/plain' && subpart.body?.data) {
            body += atob(subpart.body.data.replace(/-/g, '+').replace(/_/g, '/'));
          }
        }
      }
    }
  }
  return body.substring(0, 1000);
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

async function markMessagesProcessed(
  supabase: any,
  userId: string,
  connectionId: string,
  messageIds: string[],
  contactsExtracted: number,
  extractionData: any
): Promise<void> {
  const CHUNK = 50;
  for (let i = 0; i < messageIds.length; i += CHUNK) {
    const chunk = messageIds.slice(i, i + CHUNK);
    await supabase.from('gmail_processed_messages').upsert(
      chunk.map(msgId => ({
        user_id: userId,
        connection_id: connectionId,
        gmail_message_id: msgId,
        contacts_extracted: contactsExtracted,
        extraction_data: extractionData,
      })),
      { onConflict: 'connection_id,gmail_message_id', ignoreDuplicates: false }
    );
  }
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

    const safeMax = Math.min(max_emails, 100);
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

    // Mark skipped messages as processed immediately
    if (skipIds.length > 0) {
      await markMessagesProcessed(supabase, user_id, connection_id, skipIds, 0, null);
    }

    const contactsMap = new Map<string, ExtractedContact>();
    const allProcessedIds: string[] = [];

    for (let i = 0; i < emailsToProcess.length; i += BATCH_SIZE) {
      const batch = emailsToProcess.slice(i, i + BATCH_SIZE);
      const batchResults = await extractContactsBatchWithAI(batch, openaiApiKey);

      const batchProcessedIds: string[] = [];

      for (const emailData of batch) {
        const result = batchResults.get(emailData.messageId);
        const domain = emailData.email.split('@')[1] || '';

        // Mark ALL emails as processed (regardless of confidence)
        // This prevents them from showing up again next run
        batchProcessedIds.push(emailData.messageId);
        allProcessedIds.push(emailData.messageId);

        if (result && result.confidence && result.confidence >= 0.4) {
          // For generic domains (gmail etc), use the email as key to avoid merging unrelated contacts
          const companyKey = isGenericDomain(domain)
            ? (result.companyName ? result.companyName.toLowerCase() : emailData.email)
            : domain;

          const existing = contactsMap.get(companyKey);

          if (existing) {
            if (!existing.emailIds.includes(emailData.email)) existing.emailIds.push(emailData.email);
            existing.confidence = Math.max(existing.confidence, result.confidence);
            if (!existing.companyName && result.companyName) existing.companyName = result.companyName;
            if (!existing.phone && result.phone) existing.phone = result.phone;
            if (!existing.mobile && result.mobile) existing.mobile = result.mobile;
            if (!existing.website && result.website) existing.website = result.website;
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
        }
      }

      // Mark batch as processed using upsert to handle unique constraint
      await markMessagesProcessed(supabase, user_id, connection_id, batchProcessedIds, 1, null);

      console.log(`Batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(emailsToProcess.length / BATCH_SIZE)} done. Contacts so far: ${contactsMap.size}`);
    }

    // Include contacts with just a customer name (no company) if confidence >= 0.5
    const contacts = Array.from(contactsMap.values())
      .filter(c => (c.companyName?.length > 1 || c.confidence >= 0.6) && c.customerName)
      .map(c => ({ ...c, emailIds: c.emailIds.join('; ') }));

    console.log(`Done. ${contacts.length} contacts from ${messages.length} emails`);

    return new Response(
      JSON.stringify({
        success: true,
        total_emails_scanned: messages.length,
        total_contacts: contacts.length,
        contacts,
        message: `Processed ${messages.length} new emails and extracted ${contacts.length} contacts`
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
