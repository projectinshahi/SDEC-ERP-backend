import { Request, Response } from 'express';

/**
 * Handle authentication login request
 * Validates request parameters and evaluates against hardcoded admin credentials.
 */
export const login = async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    // Simple validation of required parameters
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    // Evaluate credentials against hardcoded default system admin accounts
    const DEFAULT_EMAIL = 'admin@gmail.com';
    const DEFAULT_PASSWORD = 'admin123';

    if (email === DEFAULT_EMAIL && password === DEFAULT_PASSWORD) {
      return res.status(200).json({
        message: 'Login successful',
        token: 'dummy-jwt-token',
      });
    }

    // Respond with appropriate status code and formatted validation message on failure
    return res.status(401).json({
      error: 'Invalid credentials',
    });
  } catch (error: any) {
    console.error('Error during default authentication:', error.message || error);
    return res.status(500).json({
      error: 'An unexpected internal authentication error occurred',
    });
  }
};
