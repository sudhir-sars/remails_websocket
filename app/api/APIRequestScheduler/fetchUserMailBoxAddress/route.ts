import { NextRequest, NextResponse } from 'next/server';
import { OAuth2Client } from 'google-auth-library';
import { google } from 'googleapis';
import jwt from 'jsonwebtoken';
import connectDb from '@/middleware/db/mongoose';
import UserMailBoxAddress from '@/middleware/db/Model/userMailBoxAddress/UserMailBoxAddress';
import { unwantedKeywords, unwantedDomains } from '@/app/api/utils/fromEmailIrrelevantList';

const oAuth2Client = new OAuth2Client(
  process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID!,
  process.env.NEXT_PUBLIC_GOOGLE_CLIENT_SECRET!
);

interface DecodedToken {
  refreshToken: string;
}



interface EmailHeaders {
  id: string;
  from: EmailAddress[];
  to: EmailAddress[];
  cc: EmailAddress[];
  bcc: EmailAddress[];
}
interface EmailAddress {
  email: string;
  name: string;
}

// Define the interface for the userMailBoxAddress data
interface UserMailBoxAddressData {
  fromAddresses: EmailAddress[];
  toAddresses: EmailAddress[];
  metaAddresses: EmailAddress[];
}

function isUnwantedEmail(email: string, name: string): boolean {
  const lowerCaseEmail = email.toLowerCase();

  // Check for unwanted keywords in the local part of the email
  const [localPart, domainPart] = lowerCaseEmail.split('@');
  if (!domainPart) return false; // Invalid email format

  // Convert Set to Array for .some() method
  const unwantedKeywordsArray = Array.from(unwantedKeywords);
  const unwantedDomainsArray = Array.from(unwantedDomains);

  // Check for unwanted keywords
  if (unwantedKeywordsArray.some(keyword => localPart.includes(keyword))) {
    return true;
  }

  // Check for unwanted domains
  if (unwantedDomainsArray.includes(domainPart)) {
    return true;
  }

  // Additional pattern checks for known spammy or generic domains
  const spamPattern = /@(?:.*\.)?(ru|cn|xyz|tk|cc|info)$/i;
  if (spamPattern.test(lowerCaseEmail)) {
    return true;
  }

  // Specific job-related and other known service domains to filter out
  const jobSites = new Set([
    'linkedin.com', 'indeed.com', 'glassdoor.com', 'monster.com', 'careerbuilder.com',
    'ziprecruiter.com', 'workable.com', 'adp.com', 'paychex.com', 'namely.com',
    'bamboohr.com', 'gusto.com', 'zenefits.com', 'lever.co', 'greenhouse.io','github.com'
  ]);

  if (jobSites.has(domainPart)) {
    return true;
  }

  return false;
}

function filterUnwantedEmails(emailAddresses: EmailAddress[]): EmailAddress[] {
  return emailAddresses.filter(({ email, name }) => !isUnwantedEmail(email, name));
}

function extractEmailAddresses(header: string): EmailAddress[] {
  const addresses: EmailAddress[] = [];

  header.split(',').forEach(part => {
    part = part.trim();
    let email = '';
    let name = '';

    if (part.includes('<') && part.includes('>')) {
      const match = part.match(/(.*)\s*<([^>]+)>/);
      if (match) {
        name = match[1].trim();
        email = match[2].trim();
      }
    } else {
      email = part;
      name = part.split('@')[0];
      // Remove non-alphabetic characters from name
      name = name.replace(/[^a-zA-Z]+/g, '');
    }

    if (email.includes('@')) {
      addresses.push({ email, name });
    }
  });

  return addresses;
}

async function fetchEmailAddresses(auth: OAuth2Client, messageIds: string[]): Promise<EmailHeaders[]> {
  const gmail = google.gmail({ version: 'v1', auth });
  const userId = 'me';
  const headersToFetch = ['From', 'To', 'Cc', 'Bcc'];

  const fetchEmailAddressesForMessage = async (messageId: string): Promise<EmailHeaders | null> => {
    try {
      const { data } = await gmail.users.messages.get({
        userId,
        id: messageId,
        format: 'metadata',
        metadataHeaders: headersToFetch,
      });

      const headers = data.payload?.headers || [];
      const getHeader = (name: string) => headers.find(header => header.name?.toLowerCase() === name.toLowerCase())?.value || '';

      const result: EmailHeaders = {
        id: messageId,
        from: extractEmailAddresses(getHeader('From')),
        to: extractEmailAddresses(getHeader('To')),
        cc: extractEmailAddresses(getHeader('Cc')),
        bcc: extractEmailAddresses(getHeader('Bcc')),
      };

      return result;
    } catch (err) {
      console.error(`Error fetching email addresses for message ${messageId}:`, err);
      return null;
    }
  };

  return (await Promise.all(messageIds.map(fetchEmailAddressesForMessage))).filter((emailHeaders): emailHeaders is EmailHeaders => emailHeaders !== null);
}

const handler = async (req: NextRequest) => {
  try {
    const { messageIds, token, userId } = await req.json();

    if (!token || !messageIds?.length || !userId) {
      return NextResponse.json({ success: false, error: 'Missing token, messageIds, or userId parameter' }, { status: 400 });
    }

    // Verify and set credentials
    const decoded = jwt.verify(token, process.env.NEXT_PUBLIC_JWT_SECRET!) as DecodedToken;
    oAuth2Client.setCredentials({ refresh_token: decoded.refreshToken });
    const { credentials } = await oAuth2Client.refreshAccessToken();
    oAuth2Client.setCredentials(credentials);

    // Fetch email addresses
    const emailAddresses = await fetchEmailAddresses(oAuth2Client, messageIds);

    // Fetch existing data from the database
    const userMailBoxAddress = await UserMailBoxAddress.findOne({ userId }) as UserMailBoxAddressData | null;

    // Prepare data for updating
    const existingData = userMailBoxAddress ? {
      fromAddresses: new Map(userMailBoxAddress.fromAddresses.map((addr: EmailAddress) => [addr.email, addr.name])),
      toAddresses: new Map(userMailBoxAddress.toAddresses.map((addr: EmailAddress) => [addr.email, addr.name])),
      metaAddresses: new Map(userMailBoxAddress.metaAddresses.map((addr: EmailAddress) => [addr.email, addr.name])),
    } : {
      fromAddresses: new Map<string, string>(),
      toAddresses: new Map<string, string>(),
      metaAddresses: new Map<string, string>(),
    };

    // Update data with new email addresses
    emailAddresses.forEach(email => {
      email.from = filterUnwantedEmails(email.from);
      email.to = filterUnwantedEmails(email.to);
      const metaAddresses = filterUnwantedEmails([...email.from, ...email.to, ...email.cc, ...email.bcc]);

      email.from.forEach(({ email: addr, name }) => {
        existingData.fromAddresses.set(addr, name);
      });

      email.to.forEach(({ email: addr, name }) => {
        existingData.toAddresses.set(addr, name);
      });

      metaAddresses.forEach(({ email: addr, name }) => {
        existingData.metaAddresses.set(addr, name);
      });
    });

    // Prepare final update data
    const updateData = {
      fromAddresses: Array.from(existingData.fromAddresses.entries()).map(([email, name]) => ({ email, name })),
      toAddresses: Array.from(existingData.toAddresses.entries()).map(([email, name]) => ({ email, name })),
      metaAddresses: Array.from(existingData.metaAddresses.entries()).map(([email, name]) => ({ email, name })),
    };

    // console.log('Update Data:', updateData); // Log update data to verify

    // Update database
    const result = await UserMailBoxAddress.findOneAndUpdate({ userId }, updateData, { upsert: true, new: true });

    if (!result) {
      console.error('Failed to update database');
    }

    return NextResponse.json({ success: true, data: updateData }, { status: 200 });
  } catch (error) {
    console.error('Error retrieving email addresses or updating database:', error);
    return NextResponse.json({ success: false, error: 'Failed to retrieve email addresses or update database' }, { status: 500 });
  }
};

export const POST = connectDb(handler);