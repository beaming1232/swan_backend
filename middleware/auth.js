import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'AUTH101010233234242fefddsfsdfs';

// Middleware to verify JWT token
export const verifyToken = (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    
    if (!token) {
      return res.status(401).json({ error: "No token provided" });
    }

    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    res.status(401).json({ error: "Invalid or expired token" });
  }
};

// Middleware to check if user is PoliceMa
export const verifyPoliceMan = (req, res, next) => {
  if (req.user && req.user.category === 'PoliceMa') {
    next();
  } else {
    res.status(403).json({ error: "Access denied. Only PoliceMa can access this resource." });
  }
};
