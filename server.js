const path = require("path");
const express = require("express");
const multer = require("multer");
const dotenv = require("dotenv");
const { MongoClient } = require("mongodb");
const { v2: cloudinary } = require("cloudinary");

dotenv.config({ path: path.join(__dirname, ".env.local") });
dotenv.config({ path: path.join(__dirname, "html", ".env.local"), override: false });

const app = express();
const maxHostedUploadBytes = 4 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: maxHostedUploadBytes } });
const allowedUploadMimeTypes = new Set([
  "image/jpeg",
  "image/png",
  "application/pdf",
]);

const port = Number(process.env.PORT || 3000);
const mongoUri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB_NAME || "aiubian_in_europe";
const collectionName = "meetup26";
const cloudinaryCloudName = process.env.CLOUDINARY_CLOUD_NAME;
const cloudinaryApiKey = process.env.CLOUDINARY_API_KEY;
const cloudinaryApiSecret = process.env.CLOUDINARY_API_SECRET;

cloudinary.config({
  cloud_name: cloudinaryCloudName,
  api_key: cloudinaryApiKey,
  api_secret: cloudinaryApiSecret,
});

const mongoClient = mongoUri ? new MongoClient(mongoUri) : null;
let collectionPromise;
let startupValidationError = null;

const requiredEnvVars = [
  ["MONGODB_URI", mongoUri],
  ["CLOUDINARY_CLOUD_NAME", cloudinaryCloudName],
  ["CLOUDINARY_API_KEY", cloudinaryApiKey],
  ["CLOUDINARY_API_SECRET", cloudinaryApiSecret],
];

const missingEnvVars = requiredEnvVars
  .filter(([, value]) => !String(value ?? "").trim())
  .map(([name]) => name);

if (missingEnvVars.length > 0) {
  startupValidationError = new Error(
    `Missing required environment variables: ${missingEnvVars.join(", ")}`
  );
  startupValidationError.statusCode = 500;
}

const getCollection = async () => {
  if (startupValidationError) {
    throw startupValidationError;
  }

  if (!collectionPromise) {
    if (!mongoClient) {
      throw startupValidationError || new Error("MongoDB client is not configured.");
    }

    collectionPromise = mongoClient.connect().then((client) => client.db(dbName).collection(collectionName));
  }
  return collectionPromise;
};

const normalizeTshirtSize = (value) => {
  const normalized = String(value ?? "").trim();
  return !normalized || normalized === "-" ? "N/A" : normalized;
};

const uploadToCloudinary = (file, folder, resourceType = "auto") =>
  new Promise((resolve, reject) => {
    if (!file) {
      resolve(null);
      return;
    }

    if (startupValidationError) {
      reject(startupValidationError);
      return;
    }

    const stream = cloudinary.uploader.upload_stream(
      {
        folder,
        resource_type: resourceType,
        use_filename: true,
        unique_filename: true,
      },
      (error, result) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(result);
      }
    );

    stream.end(file.buffer);
  });

const validateUpload = (file, label) => {
  if (!file) return;

  if (!allowedUploadMimeTypes.has(file.mimetype)) {
    const error = new Error(`${label} must be a PDF, JPG, JPEG, or PNG file.`);
    error.statusCode = 400;
    throw error;
  }
};

const validateCombinedUploadSize = (files) => {
  const totalBytes = files.reduce((sum, file) => sum + (file?.size || 0), 0);

  if (totalBytes > maxHostedUploadBytes) {
    const error = new Error(
      "The total size of the photo and payment proof must stay under 4 MB on the hosted site."
    );
    error.statusCode = 400;
    throw error;
  }
};

const parseInteger = (value, fallback = 0) => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isNaN(parsed) ? fallback : parsed;
};

const getPublicErrorMessage = (error, fallbackMessage) => {
  if (!error) return fallbackMessage;

  if (error.statusCode === 400 && error.message) {
    return error.message;
  }

  if (typeof error.http_code === "number" && error.message) {
    return `Upload failed: ${error.message}`;
  }

  if (typeof error.message === "string") {
    if (/cloudinary/i.test(error.message)) {
      return `Upload failed: ${error.message}`;
    }

    if (/unsupported|invalid|file size|too large|pdf|jpeg|jpg|png/i.test(error.message)) {
      return error.message;
    }
  }

  return fallbackMessage;
};

const computeAmounts = ({ professionalStatus, coming, kids8To16 }) => {
  let baseAmount = 40;
  let spouseAmount = 0;

  if (professionalStatus === "fulltime") {
    baseAmount = 65;
  } else if (professionalStatus === "student" || professionalStatus === "other") {
    baseAmount = 40;
  }

  if (coming === "with-spouse") {
    spouseAmount = 40;
  }

  const kidsAmount = kids8To16 * 15;
  const totalAmount = baseAmount + spouseAmount + kidsAmount;

  return { baseAmount, spouseAmount, kidsAmount, totalAmount };
};

app.use("/logo", express.static(path.join(__dirname, "logo")));
app.use("/html", express.static(path.join(__dirname, "html")));
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "html", "index.html"));
});

app.post(
  "/api/registrations",
  upload.fields([
    { name: "photo", maxCount: 1 },
    { name: "payment-proof", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const files = req.files || {};
      const photoFile = files.photo?.[0] || null;
      const paymentProofFile = files["payment-proof"]?.[0] || null;

      validateUpload(photoFile, "Photo");
      validateUpload(paymentProofFile, "Payment proof");
      validateCombinedUploadSize([photoFile, paymentProofFile].filter(Boolean));

      const kids0To7 = parseInteger(req.body["kids-0-7"]);
      const kids8To16 = parseInteger(req.body["kids-8-16"]);
      const professionalStatus = req.body["professional-status"] || "student";
      const coming = req.body.coming || "alone";
      const amounts = computeAmounts({ professionalStatus, coming, kids8To16 });

      const [photoUpload, paymentProofUpload] = await Promise.all([
        uploadToCloudinary(photoFile, "aiubian-in-europe/meetup26/photos", "image"),
        uploadToCloudinary(paymentProofFile, "aiubian-in-europe/meetup26/payment-proofs", "auto"),
      ]);

      const document = {
        event: {
          title: "AIUBian In Europe - Meet-Up 26, Registration Form",
          date: "2026-08-29",
          location: "SAALBAU Gallus, Frankenallee 111, 60326 Frankfurt am Main",
        },
        participant: {
          lastName: req.body["last-name"] || "",
          firstName: req.body["first-name"] || "",
          middleName: req.body["middle-name"] || "",
          email: req.body.email || "",
          phoneCode: req.body["phone-code"] || "",
          phoneNumber: req.body["phone-number"] || "",
          aiubDepartment: req.body["aiub-department"] || "",
          aiubId: req.body["aiub-id"] || "",
          currentCity: req.body["current-city"] || "",
          currentCountry: req.body["current-country"] || "",
          professionalStatus,
        },
        attendance: {
          coming,
          kids0To7,
          kids8To16,
          adults: coming === "with-spouse" ? 2 : 1,
          totalParticipants: (coming === "with-spouse" ? 2 : 1) + kids0To7 + kids8To16,
        },
        pricing: amounts,
        payment: {
          method: req.body["payment-method"] || "",
          proof: paymentProofUpload
            ? {
                originalName: paymentProofFile?.originalname || "",
                url: paymentProofUpload.secure_url,
                publicId: paymentProofUpload.public_id,
                resourceType: paymentProofUpload.resource_type,
              }
            : null,
        },
        merchandise: {
          tshirtSize: normalizeTshirtSize(req.body["tshirt-size"]),
        },
        social: {
          whatsappGroup: req.body["aiub-whatsapp"] || "",
          culturalActivities: req.body["cultural-activities"] || "",
        },
        remarks: req.body.remarks || "",
        uploads: {
          photo: photoUpload
            ? {
                originalName: photoFile?.originalname || "",
                url: photoUpload.secure_url,
                publicId: photoUpload.public_id,
                resourceType: photoUpload.resource_type,
              }
            : null,
        },
        createdAt: new Date(),
      };

      const collection = await getCollection();
      const result = await collection.insertOne(document);

      res.status(201).json({
        ok: true,
        id: result.insertedId,
        pricing: amounts,
        uploads: {
          photo: document.uploads.photo,
          paymentProof: document.payment.proof,
        },
      });
    } catch (error) {
      console.error("Registration submission failed:", error);
      res.status(error.statusCode || 500).json({
        ok: false,
        error: getPublicErrorMessage(error, "Failed to store registration"),
      });
    }
  }
);

app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError) {
    const message =
      error.code === "LIMIT_FILE_SIZE"
        ? "Each uploaded file must be 4 MB or smaller on the hosted site."
        : error.message;

    res.status(400).json({
      ok: false,
      error: message,
    });
    return;
  }

  console.error("Unhandled request failure:", error);
  res.status(error.statusCode || 500).json({
    ok: false,
    error: getPublicErrorMessage(error, "Unexpected server error"),
  });
});

if (startupValidationError) {
  console.error(startupValidationError.message);
}

if (process.env.VERCEL !== "1") {
  app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
  });
}

module.exports = app;
