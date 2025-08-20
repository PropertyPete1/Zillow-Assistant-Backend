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

export async function ensureMongo() {
  if (!process.env.MONGODB_URI) return null;
  if (mongoose.connection.readyState === 1) return mongoose.connection;
  return mongoose.connect(process.env.MONGODB_URI);
}


