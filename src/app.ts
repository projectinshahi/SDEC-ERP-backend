import express, { Application, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import routes from './routes/index.js';

const app: Application = express();

// CORS must be registered first — before helmet — so preflight OPTIONS
// requests are handled and Access-Control-Allow-* headers are set before
// Helmet's Cross-Origin-Resource-Policy header can interfere.
app.use(
  cors({
    origin: '*',           // allow all origins (tighten in production)
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: false,
  })
);

// Helmet with cross-origin policies relaxed so the browser doesn't block
// responses that already have correct CORS headers from the cors() middleware.
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    crossOriginOpenerPolicy: false,
  })
);

app.use(express.json());
app.use(morgan('dev'));

// Health Check Route
app.get('/', (req: Request, res: Response) => {
  res.json({
    success: true,
    message: "Backend running"
  });
});

// API Routes — mounted at BOTH /api and / so the server works correctly
// whether NEXT_PUBLIC_API_URL on the frontend is set to:
//   https://sdec-erp-backend.onrender.com        (no /api suffix)
//   https://sdec-erp-backend.onrender.com/api    (with /api suffix)
app.use('/api', routes);
app.use('/', routes);

// Error Handling Middleware (Basic)
app.use((err: any, req: Request, res: Response, next: express.NextFunction) => {
  console.error(err.stack);
  res.status(500).json({ success: false, message: 'Internal Server Error' });
});

export default app;

