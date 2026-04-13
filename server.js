const path = require("path");
const express = require("express");
const multer = require("multer");
const dotenv = require("dotenv");
const { MongoClient } = require("mongodb");
const { v2: cloudinary } = require("cloudinary");

dotenv.config({ path: path.join(__dirname, "html", ".env.local") });

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

const port = Number(process.env.PORT || 3000);
const mongoUri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB_NAME || "aiubian_in_europe";
const collectionName = "meetup26";

if (!mongoUri) {
  throw new Error("Missing MONGODB_URI in html/.env.local");
}

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const mongoClient = new MongoClient(mongoUri);
let collectionPromise;

const getCollection = async () => {
  if (!collectionPromise) {
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

const parseInteger = (value, fallback = 0) => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isNaN(parsed) ? fallback : parsed;
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
    { name: "payment-proof", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const files = req.files || {};
      const paymentProofFile = files["payment-proof"]?.[0] || null;

      const kids0To7 = parseInteger(req.body["kids-0-7"]);
      const kids8To16 = parseInteger(req.body["kids-8-16"]);
      const professionalStatus = req.body["professional-status"] || "student";
      const coming = req.body.coming || "alone";
      const amounts = computeAmounts({ professionalStatus, coming, kids8To16 });

      const paymentProofUpload = await uploadToCloudinary(
        paymentProofFile,
        "aiubian-in-europe/meetup26/payment-proofs",
        "auto"
      );

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
        createdAt: new Date(),
      };

      const collection = await getCollection();
      const result = await collection.insertOne(document);

      res.status(201).json({
        ok: true,
        id: result.insertedId,
        pricing: amounts,
        uploads: {
          paymentProof: document.payment.proof,
        },
      });
    } catch (error) {
      console.error("Registration submission failed:", error);
      res.status(500).json({
        ok: false,
        error: "Failed to store registration",
      });
    }
  }
);

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
