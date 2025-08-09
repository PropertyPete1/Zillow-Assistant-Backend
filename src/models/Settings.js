import mongoose from 'mongoose';

const SettingsSchema = new mongoose.Schema({
  propertyType: { type: String, enum: ['rent','sale','both'], default: 'both' },
  zipCodes: { type: [String], default: [] },
  minBedrooms: { type: Number, default: 0 },
  maxPrice: { type: Number, default: 0 },
  redFlagDetection: { type: Boolean, default: true },
  dailyMessageLimit: { type: Number, default: 5 },
  messageWindow: { type: [String], default: ['10:00','18:00'] },
  testMode: { type: Boolean, default: false },
  googleSheetUrl: { type: String, default: '' },
  autoMessages: { type: Boolean, default: false },
  zillowLogin: {
    email: { type: String, default: '' },
    passwordHash: { type: String, default: '' },
  },
}, { timestamps: true });

export default mongoose.models.Settings || mongoose.model('Settings', SettingsSchema);


