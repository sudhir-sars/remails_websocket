
import { NextRequest, NextResponse } from 'next/server';
import { jwtVerify } from 'jose';

// Get credentials and secret from environment variables
const ADMIN_USERNAME = process.env.ADMIN_USERNAME!;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD!;
const JWE_SECRET = process.env.JWE_SECRET!;

export async function POST(request: NextRequest) {
  try {
    // Extract the token from the request body
    const { token } = await request.json();

    if (!token) {
      return NextResponse.json({ message: 'Token is required' }, { status: 400 });
    }

    const secret = new TextEncoder().encode(JWE_SECRET);

    // Verify the token
    const { payload } = await jwtVerify(token, secret);

    // Extract username and password from the payload
    const { username, password } = payload as { username: string, password: string };

    // Validate username and password
    if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
      return NextResponse.json({
        success: true,
        message: 'Token is valid',
        user: {
          username
        }
      });
    } else {
      return NextResponse.json({ message: 'Invalid credentials in token' }, { status: 401 });
    }
  } catch (error) {
    // Respond with error if verification fails
    console.error('Token verification failed', error);
    return NextResponse.json({ message: 'Invalid or expired token' }, { status: 401 });
  }
}
