import mongoose from 'mongoose';

const ListingSchema = new mongoose.Schema({
  id: String,
  url: String,
  address: String,
  price: Number,
  bedrooms: Number,
  ownerName: String,
  ownerConfidence: Number,
  isLikelyCompany: Boolean,
  excludeReason: String,
  sourceSignals: Object,
  ts: String,
  status: { type: String, enum: ['KEPT','DROPPED'], default: 'KEPT' }
}, { timestamps: true });

export const ListingLog = mongoose.model('ListingLog', ListingSchema);

const MessageSchema = new mongoose.Schema({
  listingId: { type: String, index: true },
  listingUrl: String,
  address: String,
  ownerName: String,
  messageText: String,
  status: { type: String, enum: ['SENT','BLOCKED_DUP','FAILED','CONFIRMED_BUT_NOT_SENT'], default: 'SENT' },
  reason: String,
  meta: Object,
  sentAt: Date
}, { timestamps: true });

MessageSchema.index({ listingId: 1, status: 1, createdAt: 1 });
export const MessageLog = mongoose.model('MessageLog', MessageSchema);

export async function ensureMongo() {
  if (!process.env.MONGODB_URI) return null;
  if (mongoose.connection.readyState === 1) return mongoose.connection;
  return mongoose.connect(process.env.MONGODB_URI);
}


