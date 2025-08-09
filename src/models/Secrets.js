import mongoose from 'mongoose';

const SecretsSchema = new mongoose.Schema({
  googleServiceAccountEmail: { type: String },
  googleServiceAccountKey: { type: String }, // JSON or PEM string
}, { timestamps: true });

export default mongoose.models.Secrets || mongoose.model('Secrets', SecretsSchema);


