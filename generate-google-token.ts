import { google } from 'googleapis';
import * as dotenv from 'dotenv';
import * as readline from 'readline';

dotenv.config();

const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI } = process.env;

if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REDIRECT_URI) {
  console.error("Error: Please ensure GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI are set in your .env file.");
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REDIRECT_URI
);

// Required scopes for Google Calendar integration
const SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.events',
];

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline', // Essential for getting a refresh token
  scope: SCOPES,
  prompt: 'consent', // Forces the consent screen to ensure a refresh token is returned
});

console.log('====================================================');
console.log('1. Authorize this app by visiting this URL in your browser:');
console.log(authUrl);
console.log('====================================================\n');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

rl.question('2. Enter the authorization code from the callback URL here: ', async (code) => {
  rl.close();
  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    console.log('\n✅ Successfully obtained tokens!');
    console.log('----------------------------------------------------');
    console.log('Refresh Token:', tokens.refresh_token);
    console.log('Access Token:', tokens.access_token);
    console.log('Expiry Date:', new Date(tokens.expiry_date || 0).toLocaleString());
    console.log('----------------------------------------------------');
    console.log('\n👉 ACTION REQUIRED:');
    console.log('Please copy the Refresh Token above and save it to your .env file as:');
    console.log('GOOGLE_REFRESH_TOKEN=your_refresh_token_here');
  } catch (err) {
    console.error('❌ Error retrieving access token:', err);
  }
});
