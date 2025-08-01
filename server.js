require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs').promises;
const ffmpeg = require('fluent-ffmpeg');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Serve static files (frontend)
app.use(express.static(path.join(__dirname, 'public')));

// File upload setup
const upload = multer({ 
  dest: 'uploads/',
  limits: { fileSize: 100 * 1024 * 1024 } // 100MB limit
});

// In-memory database (replace with MongoDB in production)
const users = new Map();
const sessions = new Map();

// Helper: Generate JWT token
const generateToken = (userId) => {
  return jwt.sign({ userId }, process.env.JWT_SECRET || 'audiocraft-secret-key-2024', { expiresIn: '7d' });
};

// Helper: Check if FFmpeg is available
const checkFFmpeg = () => {
  return new Promise((resolve) => {
    // Set FFmpeg path if provided
    if (process.env.FFMPEG_PATH) {
      ffmpeg.setFfmpegPath(process.env.FFMPEG_PATH);
    }
    
    ffmpeg.getAvailableFormats((err, formats) => {
      if (err) {
        console.log('⚠️  FFmpeg not available, using simulation mode');
        resolve(false);
      } else {
        console.log('✅ FFmpeg detected and ready');
        resolve(true);
      }
    });
  });
};

// Helper: Process audio with real effects
const processAudioWithEffects = (inputPath, outputPath, settings) => {
  return new Promise((resolve, reject) => {
    console.log('🎵 Processing audio with settings:', settings);
    
    // Convert settings to FFmpeg parameters
    const pitchSemitones = parseFloat(settings.pitch) || 0.1;
    const tempoPercent = parseFloat(settings.tempo) || 99.5;
    const warmthLevel = parseFloat(settings.warmth) || 8;
    const reverbLevel = parseFloat(settings.reverb) || 8;
    
    // Calculate pitch shift (semitones to frequency ratio)
    const pitchRatio = Math.pow(2, pitchSemitones / 12);
    
    // Build audio filter chain for subtle "humanization"
    const audioFilters = [];
    
    // 1. Tempo adjustment (very subtle)
    if (tempoPercent !== 100) {
      audioFilters.push(`atempo=${tempoPercent / 100}`);
    }
    
    // 2. Pitch adjustment (very subtle)
    if (pitchSemitones !== 0) {
      audioFilters.push(`asetrate=44100*${pitchRatio},aresample=44100`);
    }
    
    // 3. Harmonic warmth (subtle saturation)
    if (warmthLevel > 0) {
      const saturation = 1 + (warmthLevel / 200); // Very subtle
      audioFilters.push(`acompressor=ratio=2:threshold=-20dB:makeup=${saturation}`);
    }
    
    // 4. Spatial reverb (very light room ambience)
    if (reverbLevel > 0) {
      const reverbAmount = reverbLevel / 100;
      audioFilters.push(`aecho=0.8:0.9:${reverbAmount * 50}:${reverbAmount * 0.3}`);
    }
    
    // 5. Final normalization and subtle EQ
    audioFilters.push('dynaudnorm=p=0.9:s=5');
    audioFilters.push('equalizer=f=1000:width_type=h:width=200:g=0.5'); // Subtle mid boost
    
    console.log('🔧 Applying filters:', audioFilters);
    
    ffmpeg(inputPath)
      .audioFilters(audioFilters)
      .audioCodec('libmp3lame')
      .audioBitrate('320k')
      .format('mp3')
      .output(outputPath)
      .on('start', (commandLine) => {
        console.log('🚀 FFmpeg command:', commandLine);
      })
      .on('progress', (progress) => {
        console.log('⏳ Processing: ' + Math.round(progress.percent) + '% done');
      })
      .on('end', () => {
        console.log('✅ Audio processing complete');
        resolve(outputPath);
      })
      .on('error', (err, stdout, stderr) => {
        console.error('❌ FFmpeg error:', err.message);
        console.error('FFmpeg stderr:', stderr);
        reject(new Error(`Audio processing failed: ${err.message}`));
      })
      .run();
  });
};

// === AUTH ROUTES ===

// Signup
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    if (users.has(email)) {
      return res.status(400).json({ message: 'User already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const userId = uuidv4();
    
    const user = {
      id: userId,
      email,
      password: hashedPassword,
      freeTracksLeft: 5, // 5 free enhancements
      subscription: { status: 'none' },
      createdAt: new Date()
    };
    
    users.set(email, user);
    const token = generateToken(userId);
    
    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        email: user.email,
        freeTracksLeft: user.freeTracksLeft,
        subscription: user.subscription
      }
    });
  } catch (error) {
    console.error('Signup error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = users.get(email);
    
    if (!user) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }
    
    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }
    
    const token = generateToken(user.id);
    
    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        email: user.email,
        freeTracksLeft: user.freeTracksLeft,
        subscription: user.subscription
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Verify token
app.get('/api/auth/verify', (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
      return res.status(401).json({ message: 'No token' });
    }
    
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'audiocraft-secret-key-2024');
    const user = Array.from(users.values()).find(u => u.id === decoded.userId);
    
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    
    res.json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        freeTracksLeft: user.freeTracksLeft,
        subscription: user.subscription
      }
    });
  } catch (error) {
    console.error('Token verification error:', error);
    res.status(401).json({ message: 'Invalid token' });
  }
});

// === AUDIO ROUTES ===

// Process audio with REAL enhancement
app.post('/api/audio/enhance', upload.single('audio'), async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
      return res.status(401).json({ message: 'Unauthorized' });
    }
    
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'audiocraft-secret-key-2024');
    const user = Array.from(users.values()).find(u => u.id === decoded.userId);
    
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    
    // Check if user can process
    if (user.subscription.status !== 'active' && user.freeTracksLeft <= 0) {
      return res.status(403).json({ message: 'No credits remaining' });
    }
    
    if (!req.file) {
      return res.status(400).json({ message: 'No audio file provided' });
    }
    
    const settings = JSON.parse(req.body.settings || '{}');
    const inputPath = req.file.path;
    const enhancedFileName = `enhanced_${uuidv4()}.mp3`;
    const outputPath = path.join('uploads', enhancedFileName);
    
    console.log('🎵 Starting audio enhancement for user:', user.email);
    console.log('📁 Input file:', req.file.originalname, '(' + Math.round(req.file.size / 1024) + 'KB)');
    
    // Check if FFmpeg is available
    const ffmpegAvailable = await checkFFmpeg();
    
    if (ffmpegAvailable) {
      // REAL AUDIO PROCESSING
      try {
        await processAudioWithEffects(inputPath, outputPath, settings);
        
        // Deduct credit
        if (user.subscription.status !== 'active') {
          user.freeTracksLeft -= 1;
          console.log('💳 Credits remaining for', user.email + ':', user.freeTracksLeft);
        }
        
        // Send enhanced file
        res.download(outputPath, `enhanced_${req.file.originalname}`, (err) => {
          if (err) {
            console.error('Download error:', err);
          }
          
          // Cleanup files after download
          setTimeout(async () => {
            try {
              await fs.unlink(inputPath);
              await fs.unlink(outputPath);
              console.log('🗑️  Cleaned up temporary files');
            } catch (cleanupError) {
              console.error('Cleanup error:', cleanupError);
            }
          }, 30000); // Clean up after 30 seconds (reduced from 60s)
        });
        
      } catch (processingError) {
        console.error('Audio processing failed:', processingError);
        await fs.unlink(inputPath).catch(console.error);
        return res.status(500).json({ 
          message: 'Audio processing failed', 
          error: processingError.message 
        });
      }
      
    } else {
      // FALLBACK: Simulation mode (return original file)
      console.log('⚠️  Running in simulation mode - returning original file');
      
      // Deduct credit even in simulation
      if (user.subscription.status !== 'active') {
        user.freeTracksLeft -= 1;
      }
      
      res.download(inputPath, `enhanced_${req.file.originalname}`, (err) => {
        if (err) {
          console.error('Download error:', err);
        }
        
        setTimeout(async () => {
          await fs.unlink(inputPath).catch(console.error);
        }, 30000);
      });
    }
    
  } catch (error) {
    console.error('Enhancement error:', error);
    if (req.file) {
      await fs.unlink(req.file.path).catch(console.error);
    }
    res.status(500).json({ message: 'Processing failed' });
  }
});

// === HEALTH CHECK ===
app.get('/api/health', async (req, res) => {
  const ffmpegAvailable = await checkFFmpeg();
  
  res.json({ 
    status: 'OK', 
    timestamp: new Date(),
    environment: process.env.NODE_ENV || 'development',
    service: 'AudioCraft Studio API',
    audioProcessing: ffmpegAvailable ? 'REAL' : 'SIMULATION',
    version: '2.0.0'
  });
});

// 🔧 FIXED: Only serve frontend HTML for non-API routes
app.get(/^(?!\/api).*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server (Railway compatible)
const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`🚀 AudioCraft Studio v2.0 running on port ${PORT}`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`📁 Serving frontend from: ${path.join(__dirname, 'public')}`);
  
  // Check audio processing capability
  const ffmpegReady = await checkFFmpeg();
  console.log(`🎵 Audio processing: ${ffmpegReady ? 'REAL' : 'SIMULATION'} mode`);
  
  // Create directories
  require('fs').mkdirSync('uploads', { recursive: true });
  require('fs').mkdirSync('public', { recursive: true });
  
  console.log('✅ AudioCraft Studio ready for audio enhancement!');
});