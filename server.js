import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import pkg from 'pg';
import path from 'path';
import { fileURLToPath } from 'url';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { isValidVinFormat, decodeVinWithNhtsa, mapNhtsaResultToVehicle } from './vinDecoder.js';
import {
  EMAIL_REGEX,
  hashPassword,
  verifyPassword,
  signToken,
  setAuthCookie,
  clearAuthCookie,
  requireAuth,
} from './auth.js';
import {
  getMpesaConfigStatus,
  normalizeKenyanPhone,
  initiateStkPush,
  parseStkCallback,
} from './mpesa.js';
import { issueOtp, verifyOtp, sendSms } from './otp.js';

const { Pool } = pkg;
dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, 'dist');

// In production the frontend is served from this same Express app, so no CORS is
// needed by default. Set ALLOWED_ORIGIN if the frontend is ever hosted separately
// (e.g. during local dev, the Vite dev server on http://localhost:5173).
const allowedOrigin = process.env.ALLOWED_ORIGIN || (process.env.NODE_ENV === 'production' ? false : 'http://localhost:5173');

const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: allowedOrigin === false ? true : allowedOrigin, credentials: true }));
app.use(express.json());
app.use(cookieParser());
app.use(express.static(distDir));

// General API rate limit, plus separate throttling for login and registration to reduce brute force / abuse.
const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false });
const registerLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many registration attempts. Please try again later.' },
});
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again later.' },
});
const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many code requests. Please try again later.' },
});
app.use('/api', apiLimiter);

const connectionString = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/vinscope';
const pool = new Pool({
  connectionString,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

function validateEnvironment() {
  const warnings = [];

  try {
    new URL(connectionString);
  } catch {
    throw new Error('Invalid DATABASE_URL. Use a full postgres or postgresql connection URL.');
  }

  if (!String(process.env.JWT_SECRET || '').trim()) {
    warnings.push('JWT_SECRET is empty. A random runtime secret will be generated, which invalidates sessions after restart.');
  }

  const mpesaStatus = getMpesaConfigStatus();
  if (mpesaStatus.partiallyConfigured) {
    warnings.push(`M-Pesa is partially configured. Missing: ${mpesaStatus.missing.join(', ')}. STK push will fall back to demo mode.`);
  }

  const publicBaseUrl = String(process.env.PUBLIC_BASE_URL || '').trim();
  if (publicBaseUrl && !publicBaseUrl.startsWith('https://')) {
    warnings.push('PUBLIC_BASE_URL should be HTTPS for M-Pesa callbacks.');
  }

  for (const warning of warnings) {
    console.warn(`[env] ${warning}`);
  }
}

validateEnvironment();

const seedVehicles = [
  {
    vin: 'JTEBU5JR3K5001234',
    make: 'Toyota',
    model: 'Prado',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/e8/2024_Toyota_Land_Cruiser_250_VX_in_Platinum_White_Pearl_Mica%2C_front_left.jpg/500px-2024_Toyota_Land_Cruiser_250_VX_in_Platinum_White_Pearl_Mica%2C_front_left.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2017,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '1 reported incident',
    mileage: 'Mileage appears consistent',
    score: 88,
    source: 'postgres-seed',
  },
  {
    vin: 'WVWZZZ1JZ3W123456',
    make: 'Volkswagen',
    model: 'Golf',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/8a/2020_Volkswagen_Golf_Style_1.5_Front.jpg/500px-2020_Volkswagen_Golf_Style_1.5_Front.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2013,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 91,
    source: 'postgres-seed',
  },
  {
    vin: '1HGCM82633A004352',
    make: 'Honda',
    model: 'Accord',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/26/2023_Honda_Accord_LX%2C_front_left%2C_07-13-2023.jpg/500px-2023_Honda_Accord_LX%2C_front_left%2C_07-13-2023.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2003,
    status: 'Needs review',
    theft: '1 stolen report',
    ownership: '4 owners',
    accidents: '2 reported incidents',
    mileage: 'Odometer rollback suspected - readings decreased between service records',
    score: 57,
    source: 'postgres-seed',
  },
  {
    vin: '1C3CCCAB3FN123456',
    make: 'Chrysler',
    model: '300',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/c1/2016_Chrysler_300_Limited_AWD_front_4.22.19.jpg/500px-2016_Chrysler_300_Limited_AWD_front_4.22.19.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2015,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 84,
    source: 'postgres-seed',
  },
  {
    vin: '2T2BK1BA5KC123456',
    make: 'Toyota',
    model: 'Camry',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ac/2018_Toyota_Camry_%28ASV70R%29_Ascent_sedan_%282018-08-27%29_01.jpg/500px-2018_Toyota_Camry_%28ASV70R%29_Ascent_sedan_%282018-08-27%29_01.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2019,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '1 reported incident',
    mileage: 'Mileage appears consistent',
    score: 90,
    source: 'postgres-seed',
  },
  {
    vin: '5YJ3E1EA7KF123456',
    make: 'Tesla',
    model: 'Model 3',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Tesla_Model_3_%282023%29_Autofr%C3%BChling_Ulm_IMG_9282.jpg/500px-Tesla_Model_3_%282023%29_Autofr%C3%BChling_Ulm_IMG_9282.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2019,
    status: 'Verified',
    theft: 'No record',
    ownership: 'New Import',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent (new import)',
    score: 95,
    source: 'postgres-seed',
  },
  {
    vin: '3VWJP7AT5KM123456',
    make: 'Volkswagen',
    model: 'Jetta',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/aa/2019_Volkswagen_Jetta_1.4T_R-Line_in_Haba%C3%B1ero_Orange_Metallic%2C_front_right.jpg/500px-2019_Volkswagen_Jetta_1.4T_R-Line_in_Haba%C3%B1ero_Orange_Metallic%2C_front_right.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2019,
    status: 'Needs review',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '1 reported incident',
    mileage: 'Gap detected between mileage recordings - unexplained interval with no data',
    score: 70,
    source: 'postgres-seed',
  },
  {
    vin: 'WBA3B5C50FK123456',
    make: 'BMW',
    model: '330i',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/9/91/BMW_G20_%282022%29_IMG_7316_%282%29.jpg/500px-BMW_G20_%282022%29_IMG_7316_%282%29.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2015,
    status: 'Verified',
    theft: 'No record',
    ownership: '3 owners',
    accidents: '2 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 86,
    source: 'postgres-seed',
  },
  {
    vin: 'TRUWT28N82K123456',
    make: 'Nissan',
    model: 'X-Trail',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/35/Nissan_X-Trail_%28T33%29_1X7A7179.jpg/500px-Nissan_X-Trail_%28T33%29_1X7A7179.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2002,
    status: 'Needs review',
    theft: '1 stolen report',
    ownership: '4 owners',
    accidents: '3 reported incidents',
    mileage: 'Mileage jumped sharply between recordings with no supporting service history',
    score: 54,
    source: 'postgres-seed',
  },
  {
    vin: 'SALWA2BE7HA123456',
    make: 'Land Rover',
    model: 'Evoque',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/84/2019_Land_Rover_Range_Rover_Evoque_R-Dynamic_2.0.jpg/500px-2019_Land_Rover_Range_Rover_Evoque_R-Dynamic_2.0.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2017,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '1 reported incident',
    mileage: 'Mileage appears consistent',
    score: 82,
    source: 'postgres-seed',
  },
  {
    vin: 'JHMGK8H34MC123456',
    make: 'Honda',
    model: 'Civic',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/1a/Honda_Civic_e-HEV_Sport_%28XI%29_%E2%80%93_f_30062024.jpg/500px-Honda_Civic_e-HEV_Sport_%28XI%29_%E2%80%93_f_30062024.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2021,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 92,
    source: 'postgres-seed',
  },
  {
    vin: 'WAUZZZ8G9DA123456',
    make: 'Audi',
    model: 'A4',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/35/Audi_A4_B9_sedans_%28FL%29_1X7A2441.jpg/500px-Audi_A4_B9_sedans_%28FL%29_1X7A2441.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2013,
    status: 'Needs review',
    theft: 'No record',
    ownership: '3 owners',
    accidents: '1 reported incident',
    mileage: 'Gap detected between mileage recordings - unexplained interval with no data',
    score: 66,
    source: 'postgres-seed',
  },
  {
    vin: 'MBHDC9EAXPC123456',
    make: 'Mercedes-Benz',
    model: 'C-Class',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/b/be/Mercedes-Benz_W206_IMG_6380.jpg/500px-Mercedes-Benz_W206_IMG_6380.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2022,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 94,
    source: 'postgres-seed',
  },
  {
    vin: 'JTD4LZRGMCZ435SSD',
    make: 'Toyota',
    model: 'Corolla Fielder',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/f/fe/Toyota_Corolla_Hybrid_%28E210%29_IMG_4338.jpg/500px-Toyota_Corolla_Hybrid_%28E210%29_IMG_4338.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2015,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '2 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 83,
    source: 'postgres-seed',
  },
  {
    vin: 'JTE13HJW1DXGLJ9KD',
    make: 'Toyota',
    model: 'Land Cruiser Prado',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/e8/2024_Toyota_Land_Cruiser_250_VX_in_Platinum_White_Pearl_Mica%2C_front_left.jpg/500px-2024_Toyota_Land_Cruiser_250_VX_in_Platinum_White_Pearl_Mica%2C_front_left.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2016,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '1 reported incident',
    mileage: 'Mileage appears consistent',
    score: 84,
    source: 'postgres-seed',
  },
  {
    vin: 'JTMRVTT1459XZFBCL',
    make: 'Toyota',
    model: 'RAV4',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/2d/2024_Toyota_RAV4_Prime_XSE_Premium_in_Silver_Sky_with_Midnight_Black_roof%2C_front_left.jpg/500px-2024_Toyota_RAV4_Prime_XSE_Premium_in_Silver_Sky_with_Midnight_Black_roof%2C_front_left.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2008,
    status: 'Needs review',
    theft: 'No record',
    ownership: '3 owners',
    accidents: '3 reported incidents',
    mileage: 'Odometer reading unchanged across multiple recorded services',
    score: 63,
    source: 'postgres-seed',
  },
  {
    vin: 'JT2UP2HWWJ0LUW7F1',
    make: 'Toyota',
    model: 'Hilux',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/1b/2016_Toyota_HiLux_Invincible_D-4D_4WD_2.4_Front.jpg/500px-2016_Toyota_HiLux_Invincible_D-4D_4WD_2.4_Front.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2021,
    status: 'Verified',
    theft: 'No record',
    ownership: '3 owners',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 89,
    source: 'postgres-seed',
  },
  {
    vin: 'JTNPKZBB27GHGG46X',
    make: 'Toyota',
    model: 'Vitz',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/3e/2020_Toyota_Yaris_Design_HEV_CVT_1.5_Front.jpg/500px-2020_Toyota_Yaris_Design_HEV_CVT_1.5_Front.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2010,
    status: 'Needs review',
    theft: 'No record',
    ownership: '4 owners',
    accidents: '2 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 73,
    source: 'postgres-seed',
  },
  {
    vin: 'JN1AEAXH270V9AH2L',
    make: 'Nissan',
    model: 'X-Trail',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/35/Nissan_X-Trail_%28T33%29_1X7A7179.jpg/500px-Nissan_X-Trail_%28T33%29_1X7A7179.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2010,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '2 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 83,
    source: 'postgres-seed',
  },
  {
    vin: 'JN8VGLRLC7HK781US',
    make: 'Nissan',
    model: 'Note',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/41/2020-2024_Nissan_Note_S.jpg/500px-2020-2024_Nissan_Note_S.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2010,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '2 reported incidents',
    mileage: 'Odometer reading unchanged across multiple recorded services',
    score: 76,
    source: 'postgres-seed',
  },
  {
    vin: 'SJNPC6AB3AZ5WGTUG',
    make: 'Nissan',
    model: 'Navara',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/e9/2018_Nissan_Navara_Tekna_DCi_Automatic_2.3.jpg/500px-2018_Nissan_Navara_Tekna_DCi_Automatic_2.3.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2013,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '2 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 81,
    source: 'postgres-seed',
  },
  {
    vin: 'JHMPF2M5WFB4MW43N',
    make: 'Honda',
    model: 'Fit',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/85/Honda_Jazz_Hybrid_Executive_%28IV%29_%E2%80%93_f_18102020.jpg/500px-Honda_Jazz_Hybrid_Executive_%28IV%29_%E2%80%93_f_18102020.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2018,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '2 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 83,
    source: 'postgres-seed',
  },
  {
    vin: '1HGPV69MKHL1D9EEX',
    make: 'Honda',
    model: 'CR-V',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/1b/Honda_CR-V_e-HEV_Elegance_AWD_%28VI%29_%E2%80%93_f_14072024.jpg/500px-Honda_CR-V_e-HEV_Elegance_AWD_%28VI%29_%E2%80%93_f_14072024.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2020,
    status: 'Needs review',
    theft: '1 stolen report',
    ownership: 'Single owner',
    accidents: '0 reported incidents',
    mileage: 'Odometer rollback suspected - readings decreased between service records',
    score: 73,
    source: 'postgres-seed',
  },
  {
    vin: 'JM1P2XZSGHWSZ9128',
    make: 'Mazda',
    model: 'Demio',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/8d/Mazda2_Skyactiv-G_90_Homura_%28III%2C_2._Facelift%29_%E2%80%93_f_19052026.jpg/500px-Mazda2_Skyactiv-G_90_Homura_%28III%2C_2._Facelift%29_%E2%80%93_f_19052026.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2020,
    status: 'Needs review',
    theft: '1 stolen report',
    ownership: '3 owners',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 69,
    source: 'postgres-seed',
  },
  {
    vin: 'JM7F7TW9BLPHTA6AU',
    make: 'Mazda',
    model: 'CX-5',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/a5/2024_Mazda_CX-5_2.5_S_Select_in_Platinum_Quartz_Metallic%2C_front_right.jpg/500px-2024_Mazda_CX-5_2.5_S_Select_in_Platinum_Quartz_Metallic%2C_front_right.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2023,
    status: 'Verified',
    theft: 'No record',
    ownership: '4 owners',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 85,
    source: 'postgres-seed',
  },
  {
    vin: 'JA4ZDFR8LG0SXV0VU',
    make: 'Mitsubishi',
    model: 'Outlander',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/35/2025_Mitsubishi_Outlander_PHEV_%28fourth_generation%29_IMG_3129.jpg/500px-2025_Mitsubishi_Outlander_PHEV_%28fourth_generation%29_IMG_3129.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2019,
    status: 'Verified',
    theft: 'No record',
    ownership: '3 owners',
    accidents: '0 reported incidents',
    mileage: 'Mileage jumped sharply between recordings with no supporting service history',
    score: 85,
    source: 'postgres-seed',
  },
  {
    vin: 'JA3HLE78B585D4SKD',
    make: 'Mitsubishi',
    model: 'Pajero',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/36/Mitsubishi_V98_Pajero_Long_Body_Super_Exceed_3200_DI-D.JPG/500px-Mitsubishi_V98_Pajero_Long_Body_Super_Exceed_3200_DI-D.JPG?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2008,
    status: 'Needs review',
    theft: 'Flagged in one source',
    ownership: 'Single owner',
    accidents: '0 reported incidents',
    mileage: 'Mileage varies from records',
    score: 70,
    source: 'postgres-seed',
  },
  {
    vin: 'JF1203PYM55V11MAC',
    make: 'Subaru',
    model: 'Forester',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/48/Subaru_Forester_%28SL%29_e-BOXER_DSC_8811.jpg/500px-Subaru_Forester_%28SL%29_e-BOXER_DSC_8811.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2008,
    status: 'Verified',
    theft: 'No record',
    ownership: '3 owners',
    accidents: '1 reported incident',
    mileage: 'Mileage appears consistent',
    score: 82,
    source: 'postgres-seed',
  },
  {
    vin: 'JF27GU6995UY4RLHP',
    make: 'Subaru',
    model: 'Impreza',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/45/Subaru_Impreza_%28GU%29_Automesse_Ludwigsburg_2024_IMG_1593.jpg/500px-Subaru_Impreza_%28GU%29_Automesse_Ludwigsburg_2024_IMG_1593.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2008,
    status: 'Verified',
    theft: 'No record',
    ownership: '3 owners',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 88,
    source: 'postgres-seed',
  },
  {
    vin: 'JS2L1DJLHH7427N27',
    make: 'Suzuki',
    model: 'Swift',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/3d/Suzuki_Swift_%282024%29_hybrid_DSC_6076.jpg/500px-Suzuki_Swift_%282024%29_hybrid_DSC_6076.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2020,
    status: 'Needs review',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '3 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 71,
    source: 'postgres-seed',
  },
  {
    vin: 'JS3PFCCJZJCCNCE09',
    make: 'Suzuki',
    model: 'Vitara',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/7/7b/2024_Suzuki_Vitara_%284th_generation%29_DSC_6083.jpg/500px-2024_Suzuki_Vitara_%284th_generation%29_DSC_6083.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2021,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 95,
    source: 'postgres-seed',
  },
  {
    vin: 'JAAPUVHPZE5YYVVGS',
    make: 'Isuzu',
    model: 'D-Max',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/0/0d/Isuzu_D-Max_%28third_generation%29_autoMOBIL_T%C3%BCbingen_2025_DSC_2758.jpg/500px-Isuzu_D-Max_%28third_generation%29_autoMOBIL_T%C3%BCbingen_2025_DSC_2758.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2017,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '1 reported incident',
    mileage: 'Mileage appears consistent',
    score: 89,
    source: 'postgres-seed',
  },
  {
    vin: 'WVW50VVT3FM7JMPMG',
    make: 'Volkswagen',
    model: 'Golf',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/8a/2020_Volkswagen_Golf_Style_1.5_Front.jpg/500px-2020_Volkswagen_Golf_Style_1.5_Front.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2018,
    status: 'Needs review',
    theft: 'No record',
    ownership: '4 owners',
    accidents: '2 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 71,
    source: 'postgres-seed',
  },
  {
    vin: '3VWFM81A1JEYTUYXY',
    make: 'Volkswagen',
    model: 'Tiguan',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/ef/Volkswagen_Tiguan_III_IMG_8823_%28cropped%29.jpg/500px-Volkswagen_Tiguan_III_IMG_8823_%28cropped%29.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2021,
    status: 'Needs review',
    theft: 'Flagged - recovered vehicle',
    ownership: '2 owners',
    accidents: '2 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 58,
    source: 'postgres-seed',
  },
  {
    vin: 'WBAZLY648H5P3UMMW',
    make: 'BMW',
    model: '320i',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/9/91/BMW_G20_%282022%29_IMG_7316_%282%29.jpg/500px-BMW_G20_%282022%29_IMG_7316_%282%29.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2020,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '1 reported incident',
    mileage: 'Mileage varies from records',
    score: 81,
    source: 'postgres-seed',
  },
  {
    vin: 'WBSPNDUL2BNWVZTFW',
    make: 'BMW',
    model: 'X5',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/f/f1/2019_BMW_X5_M50d_Automatic_3.0.jpg/500px-2019_BMW_X5_M50d_Automatic_3.0.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2014,
    status: 'Verified',
    theft: 'No record',
    ownership: '3 owners',
    accidents: '1 reported incident',
    mileage: 'Mileage varies from records',
    score: 80,
    source: 'postgres-seed',
  },
  {
    vin: 'WDDP7ACNX9J10WK54',
    make: 'Mercedes-Benz',
    model: 'C-Class',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/b/be/Mercedes-Benz_W206_IMG_6380.jpg/500px-Mercedes-Benz_W206_IMG_6380.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2012,
    status: 'Needs review',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '3 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 74,
    source: 'postgres-seed',
  },
  {
    vin: 'MBHZPMHZB27LZ79WM',
    make: 'Mercedes-Benz',
    model: 'GLC',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/2c/Mercedes-Benz_X254_1X7A6343.jpg/500px-Mercedes-Benz_X254_1X7A6343.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2005,
    status: 'Needs review',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '3 reported incidents',
    mileage: 'Mileage varies from records',
    score: 64,
    source: 'postgres-seed',
  },
  {
    vin: 'WAUSGRS09JX7E1JHT',
    make: 'Audi',
    model: 'Q5',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/6/6d/Audi_Q5_2.0_TDI_quattro_S_line_%28GU%29_%E2%80%93_f_13102025.jpg/500px-Audi_Q5_2.0_TDI_quattro_S_line_%28GU%29_%E2%80%93_f_13102025.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2021,
    status: 'Needs review',
    theft: 'No record',
    ownership: '4 owners',
    accidents: '1 reported incident',
    mileage: 'Mileage varies from records',
    score: 74,
    source: 'postgres-seed',
  },
  {
    vin: 'SALXP1TDYL4RF7RRF',
    make: 'Land Rover',
    model: 'Discovery',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/e1/2018_Land_Rover_Discovery_Luxury_HSE_TD6_3.0_Front.jpg/500px-2018_Land_Rover_Discovery_Luxury_HSE_TD6_3.0_Front.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2023,
    status: 'Needs review',
    theft: 'Flagged in one source',
    ownership: '2 owners',
    accidents: '1 reported incident',
    mileage: 'Mileage varies from records',
    score: 61,
    source: 'postgres-seed',
  },
  {
    vin: '1FADW95UNDPT1C9AA',
    make: 'Ford',
    model: 'Focus',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/7/75/2018_Ford_Focus_ST-Line_X_1.0.jpg/500px-2018_Ford_Focus_ST-Line_X_1.0.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2016,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '1 reported incident',
    mileage: 'Mileage appears consistent',
    score: 90,
    source: 'postgres-seed',
  },
  {
    vin: 'MAJAZBD3HLNP23Y3D',
    make: 'Ford',
    model: 'Ranger',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/28/Ford_Ranger_%28T6%2C_P703%29_Wildtrak_IMG_7320.jpg/500px-Ford_Ranger_%28T6%2C_P703%29_Wildtrak_IMG_7320.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2023,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '2 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 82,
    source: 'postgres-seed',
  },
  {
    vin: 'KMHSER3JDCNJ5HPGD',
    make: 'Hyundai',
    model: 'Tucson',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/c6/2022_Hyundai_Tucson_Preferred%2C_Front_Right%2C_05-24-2021.jpg/500px-2022_Hyundai_Tucson_Preferred%2C_Front_Right%2C_05-24-2021.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2015,
    status: 'Verified',
    theft: 'No record',
    ownership: '3 owners',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 89,
    source: 'postgres-seed',
  },
  {
    vin: 'KNASP62BD7W904KNS',
    make: 'Kia',
    model: 'Sportage',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/5/5d/2025_Kia_Sportage_S_front_only.jpg/500px-2025_Kia_Sportage_S_front_only.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2010,
    status: 'Needs review',
    theft: 'No record',
    ownership: '4 owners',
    accidents: '3 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 67,
    source: 'postgres-seed',
  },
  {
    vin: 'VF3SS0TT0AXRXCP39',
    make: 'Peugeot',
    model: '3008',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/ed/Peugeot_e-3008_Automesse_Ludwigsburg_2024_IMG_1537.jpg/500px-Peugeot_e-3008_Automesse_Ludwigsburg_2024_IMG_1537.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2013,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 94,
    source: 'postgres-seed',
  },
  {
    vin: 'YV16VDL3XHPZ2VVHF',
    make: 'Volvo',
    model: 'XC60',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/1a/2018_Volvo_XC60_R-Design_D5_P-Pulse_2.0_Front.jpg/500px-2018_Volvo_XC60_R-Design_D5_P-Pulse_2.0_Front.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2020,
    status: 'Verified',
    theft: 'No record',
    ownership: '3 owners',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 89,
    source: 'postgres-seed',
  },
  {
    vin: '5YJKUSGRA2LP44PYS',
    make: 'Tesla',
    model: 'Model 3',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Tesla_Model_3_%282023%29_Autofr%C3%BChling_Ulm_IMG_9282.jpg/500px-Tesla_Model_3_%282023%29_Autofr%C3%BChling_Ulm_IMG_9282.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2005,
    status: 'Needs review',
    theft: 'Flagged in one source',
    ownership: 'Single owner',
    accidents: '2 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 63,
    source: 'postgres-seed',
  },
  {
    vin: '1J40241UKJGYYFS42',
    make: 'Jeep',
    model: 'Grand Cherokee',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/6/6c/2022_Jeep_Grand_Cherokee_Summit_Reserve_4x4_in_Bright_White%2C_Front_Left%2C_01-16-2022.jpg/500px-2022_Jeep_Grand_Cherokee_Summit_Reserve_4x4_in_Bright_White%2C_Front_Left%2C_01-16-2022.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2021,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 94,
    source: 'postgres-seed',
  },
  {
    vin: '1G1UAUZG8BEE6UB3E',
    make: 'Chevrolet',
    model: 'Cruze',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/b/b4/2017_Chevrolet_Cruze_LT_in_Arctic_Blue_Metallic%2C_Front_Left.jpg/500px-2017_Chevrolet_Cruze_LT_in_Arctic_Blue_Metallic%2C_Front_Left.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2014,
    status: 'Needs review',
    theft: 'Flagged in one source',
    ownership: 'Single owner',
    accidents: '0 reported incidents',
    mileage: 'Mileage varies from records',
    score: 73,
    source: 'postgres-seed',
  },
  {
    vin: 'JTDK4PNFRALNRC4NG',
    make: 'Toyota',
    model: 'Corolla Fielder',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/f/fe/Toyota_Corolla_Hybrid_%28E210%29_IMG_4338.jpg/500px-Toyota_Corolla_Hybrid_%28E210%29_IMG_4338.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2013,
    status: 'Verified',
    theft: 'No record',
    ownership: '3 owners',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 90,
    source: 'postgres-seed',
  },
  {
    vin: 'JTE28KWKA5APDXFVM',
    make: 'Toyota',
    model: 'Land Cruiser Prado',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/e8/2024_Toyota_Land_Cruiser_250_VX_in_Platinum_White_Pearl_Mica%2C_front_left.jpg/500px-2024_Toyota_Land_Cruiser_250_VX_in_Platinum_White_Pearl_Mica%2C_front_left.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2008,
    status: 'Verified',
    theft: 'No record',
    ownership: '3 owners',
    accidents: '0 reported incidents',
    mileage: 'Mileage varies from records',
    score: 85,
    source: 'postgres-seed',
  },
  {
    vin: 'JTM23L9PXJKXR1051',
    make: 'Toyota',
    model: 'RAV4',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/2d/2024_Toyota_RAV4_Prime_XSE_Premium_in_Silver_Sky_with_Midnight_Black_roof%2C_front_left.jpg/500px-2024_Toyota_RAV4_Prime_XSE_Premium_in_Silver_Sky_with_Midnight_Black_roof%2C_front_left.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2021,
    status: 'Needs review',
    theft: '1 stolen report',
    ownership: 'Single owner',
    accidents: '1 reported incident',
    mileage: 'Mileage varies from records',
    score: 64,
    source: 'postgres-seed',
  },
  {
    vin: 'JT21C3MZED90BPY8H',
    make: 'Toyota',
    model: 'Hilux',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/1b/2016_Toyota_HiLux_Invincible_D-4D_4WD_2.4_Front.jpg/500px-2016_Toyota_HiLux_Invincible_D-4D_4WD_2.4_Front.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2016,
    status: 'Needs review',
    theft: '1 stolen report',
    ownership: '3 owners',
    accidents: '2 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 58,
    source: 'postgres-seed',
  },
  {
    vin: 'JTNDL7NNDGPBRD7VF',
    make: 'Toyota',
    model: 'Vitz',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/3e/2020_Toyota_Yaris_Design_HEV_CVT_1.5_Front.jpg/500px-2020_Toyota_Yaris_Design_HEV_CVT_1.5_Front.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2019,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '2 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 81,
    source: 'postgres-seed',
  },
  {
    vin: 'JN1BA5U14GP0YF0VD',
    make: 'Nissan',
    model: 'X-Trail',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/35/Nissan_X-Trail_%28T33%29_1X7A7179.jpg/500px-Nissan_X-Trail_%28T33%29_1X7A7179.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2019,
    status: 'Verified',
    theft: 'No record',
    ownership: '3 owners',
    accidents: '1 reported incident',
    mileage: 'Mileage varies from records',
    score: 76,
    source: 'postgres-seed',
  },
  {
    vin: 'JN8RTFASJHZXYYGHG',
    make: 'Nissan',
    model: 'Note',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/41/2020-2024_Nissan_Note_S.jpg/500px-2020-2024_Nissan_Note_S.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2020,
    status: 'Verified',
    theft: 'No record',
    ownership: '3 owners',
    accidents: '2 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 76,
    source: 'postgres-seed',
  },
  {
    vin: 'SJNXKNTN95RPY1EFP',
    make: 'Nissan',
    model: 'Navara',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/e9/2018_Nissan_Navara_Tekna_DCi_Automatic_2.3.jpg/500px-2018_Nissan_Navara_Tekna_DCi_Automatic_2.3.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2008,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 97,
    source: 'postgres-seed',
  },
  {
    vin: 'JHMAWZZGDCXGJ8STN',
    make: 'Honda',
    model: 'Fit',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/85/Honda_Jazz_Hybrid_Executive_%28IV%29_%E2%80%93_f_18102020.jpg/500px-Honda_Jazz_Hybrid_Executive_%28IV%29_%E2%80%93_f_18102020.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2015,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '2 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 81,
    source: 'postgres-seed',
  },
  {
    vin: '1HG0FR7SUGHKK7UHP',
    make: 'Honda',
    model: 'CR-V',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/1b/Honda_CR-V_e-HEV_Elegance_AWD_%28VI%29_%E2%80%93_f_14072024.jpg/500px-Honda_CR-V_e-HEV_Elegance_AWD_%28VI%29_%E2%80%93_f_14072024.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2019,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '1 reported incident',
    mileage: 'Mileage appears consistent',
    score: 92,
    source: 'postgres-seed',
  },
  {
    vin: 'JM1KNPVKW37KR6PMJ',
    make: 'Mazda',
    model: 'Demio',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/8d/Mazda2_Skyactiv-G_90_Homura_%28III%2C_2._Facelift%29_%E2%80%93_f_19052026.jpg/500px-Mazda2_Skyactiv-G_90_Homura_%28III%2C_2._Facelift%29_%E2%80%93_f_19052026.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2006,
    status: 'Verified',
    theft: 'No record',
    ownership: '3 owners',
    accidents: '1 reported incident',
    mileage: 'Mileage appears consistent',
    score: 85,
    source: 'postgres-seed',
  },
  {
    vin: 'JM7LFNU28E00TM9CW',
    make: 'Mazda',
    model: 'CX-5',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/a5/2024_Mazda_CX-5_2.5_S_Select_in_Platinum_Quartz_Metallic%2C_front_right.jpg/500px-2024_Mazda_CX-5_2.5_S_Select_in_Platinum_Quartz_Metallic%2C_front_right.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2017,
    status: 'Needs review',
    theft: 'No record',
    ownership: '3 owners',
    accidents: '3 reported incidents',
    mileage: 'Mileage varies from records',
    score: 60,
    source: 'postgres-seed',
  },
  {
    vin: 'JA45JC97H80GUSZ6F',
    make: 'Mitsubishi',
    model: 'Outlander',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/35/2025_Mitsubishi_Outlander_PHEV_%28fourth_generation%29_IMG_3129.jpg/500px-2025_Mitsubishi_Outlander_PHEV_%28fourth_generation%29_IMG_3129.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2011,
    status: 'Verified',
    theft: 'No record',
    ownership: '3 owners',
    accidents: '1 reported incident',
    mileage: 'Mileage appears consistent',
    score: 82,
    source: 'postgres-seed',
  },
  {
    vin: 'JA3XRZ0H3LX9ZX7HR',
    make: 'Mitsubishi',
    model: 'Pajero',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/36/Mitsubishi_V98_Pajero_Long_Body_Super_Exceed_3200_DI-D.JPG/500px-Mitsubishi_V98_Pajero_Long_Body_Super_Exceed_3200_DI-D.JPG?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2023,
    status: 'Verified',
    theft: 'No record',
    ownership: 'New Import',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent (new import)',
    score: 98,
    source: 'postgres-seed',
  },
  {
    vin: 'JF1RN0H2DJWF6PAND',
    make: 'Subaru',
    model: 'Forester',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/48/Subaru_Forester_%28SL%29_e-BOXER_DSC_8811.jpg/500px-Subaru_Forester_%28SL%29_e-BOXER_DSC_8811.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2021,
    status: 'Verified',
    theft: 'No record',
    ownership: 'New Import',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent (new import)',
    score: 98,
    source: 'postgres-seed',
  },
  {
    vin: 'JF2AHZ4PZAHFV9TL6',
    make: 'Subaru',
    model: 'Impreza',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/45/Subaru_Impreza_%28GU%29_Automesse_Ludwigsburg_2024_IMG_1593.jpg/500px-Subaru_Impreza_%28GU%29_Automesse_Ludwigsburg_2024_IMG_1593.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2013,
    status: 'Verified',
    theft: 'No record',
    ownership: '3 owners',
    accidents: '1 reported incident',
    mileage: 'Mileage appears consistent',
    score: 85,
    source: 'postgres-seed',
  },
  {
    vin: 'JS27FVTA1K27GXZZ3',
    make: 'Suzuki',
    model: 'Swift',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/3d/Suzuki_Swift_%282024%29_hybrid_DSC_6076.jpg/500px-Suzuki_Swift_%282024%29_hybrid_DSC_6076.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2022,
    status: 'Verified',
    theft: 'No record',
    ownership: '3 owners',
    accidents: '1 reported incident',
    mileage: 'Mileage varies from records',
    score: 78,
    source: 'postgres-seed',
  },
  {
    vin: 'JS361KNVAL193RY0T',
    make: 'Suzuki',
    model: 'Vitara',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/7/7b/2024_Suzuki_Vitara_%284th_generation%29_DSC_6083.jpg/500px-2024_Suzuki_Vitara_%284th_generation%29_DSC_6083.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2023,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 96,
    source: 'postgres-seed',
  },
  {
    vin: 'JAA9AD260B0S0NBHN',
    make: 'Isuzu',
    model: 'D-Max',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/0/0d/Isuzu_D-Max_%28third_generation%29_autoMOBIL_T%C3%BCbingen_2025_DSC_2758.jpg/500px-Isuzu_D-Max_%28third_generation%29_autoMOBIL_T%C3%BCbingen_2025_DSC_2758.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2014,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '2 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 80,
    source: 'postgres-seed',
  },
  {
    vin: 'WVWD6ZMBHCXKT6Y5Y',
    make: 'Volkswagen',
    model: 'Golf',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/8a/2020_Volkswagen_Golf_Style_1.5_Front.jpg/500px-2020_Volkswagen_Golf_Style_1.5_Front.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2015,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '2 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 77,
    source: 'postgres-seed',
  },
  {
    vin: '3VWXAFUEFKRGSBT5F',
    make: 'Volkswagen',
    model: 'Tiguan',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/ef/Volkswagen_Tiguan_III_IMG_8823_%28cropped%29.jpg/500px-Volkswagen_Tiguan_III_IMG_8823_%28cropped%29.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2022,
    status: 'Needs review',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '3 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 69,
    source: 'postgres-seed',
  },
  {
    vin: 'WBAG9D3XNCKYNDN8R',
    make: 'BMW',
    model: '320i',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/9/91/BMW_G20_%282022%29_IMG_7316_%282%29.jpg/500px-BMW_G20_%282022%29_IMG_7316_%282%29.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2015,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '1 reported incident',
    mileage: 'Mileage appears consistent',
    score: 89,
    source: 'postgres-seed',
  },
  {
    vin: 'WBSEV8UZT4BFACP7F',
    make: 'BMW',
    model: 'X5',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/f/f1/2019_BMW_X5_M50d_Automatic_3.0.jpg/500px-2019_BMW_X5_M50d_Automatic_3.0.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2007,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '2 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 80,
    source: 'postgres-seed',
  },
  {
    vin: 'WDDLCJFVZJJLNZZZK',
    make: 'Mercedes-Benz',
    model: 'C-Class',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/b/be/Mercedes-Benz_W206_IMG_6380.jpg/500px-Mercedes-Benz_W206_IMG_6380.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2021,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 97,
    source: 'postgres-seed',
  },
  {
    vin: 'MBHTEKK5R5HJJ8C8B',
    make: 'Mercedes-Benz',
    model: 'GLC',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/2c/Mercedes-Benz_X254_1X7A6343.jpg/500px-Mercedes-Benz_X254_1X7A6343.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2008,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '1 reported incident',
    mileage: 'Mileage appears consistent',
    score: 86,
    source: 'postgres-seed',
  },
  {
    vin: 'WAUYL91AM8UM7PFE7',
    make: 'Audi',
    model: 'Q5',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/6/6d/Audi_Q5_2.0_TDI_quattro_S_line_%28GU%29_%E2%80%93_f_13102025.jpg/500px-Audi_Q5_2.0_TDI_quattro_S_line_%28GU%29_%E2%80%93_f_13102025.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2011,
    status: 'Verified',
    theft: 'No record',
    ownership: '3 owners',
    accidents: '2 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 79,
    source: 'postgres-seed',
  },
  {
    vin: 'SAL797ZZJ70H0M5NS',
    make: 'Land Rover',
    model: 'Discovery',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/e1/2018_Land_Rover_Discovery_Luxury_HSE_TD6_3.0_Front.jpg/500px-2018_Land_Rover_Discovery_Luxury_HSE_TD6_3.0_Front.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2010,
    status: 'Needs review',
    theft: '1 stolen report',
    ownership: 'Single owner',
    accidents: '1 reported incident',
    mileage: 'Mileage varies from records',
    score: 66,
    source: 'postgres-seed',
  },
  {
    vin: '1FAELAVAD7XMT3PPJ',
    make: 'Ford',
    model: 'Focus',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/7/75/2018_Ford_Focus_ST-Line_X_1.0.jpg/500px-2018_Ford_Focus_ST-Line_X_1.0.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2010,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 94,
    source: 'postgres-seed',
  },
  {
    vin: 'MAJRSCRPBH5CDZ1SP',
    make: 'Ford',
    model: 'Ranger',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/28/Ford_Ranger_%28T6%2C_P703%29_Wildtrak_IMG_7320.jpg/500px-Ford_Ranger_%28T6%2C_P703%29_Wildtrak_IMG_7320.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2020,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '1 reported incident',
    mileage: 'Mileage appears consistent',
    score: 87,
    source: 'postgres-seed',
  },
  {
    vin: 'KMH1P62N2FNP8Y8F4',
    make: 'Hyundai',
    model: 'Tucson',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/c6/2022_Hyundai_Tucson_Preferred%2C_Front_Right%2C_05-24-2021.jpg/500px-2022_Hyundai_Tucson_Preferred%2C_Front_Right%2C_05-24-2021.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2018,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '2 reported incidents',
    mileage: 'Mileage varies from records',
    score: 76,
    source: 'postgres-seed',
  },
  {
    vin: 'KNAYHF0XJKM83ZX5M',
    make: 'Kia',
    model: 'Sportage',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/5/5d/2025_Kia_Sportage_S_front_only.jpg/500px-2025_Kia_Sportage_S_front_only.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2022,
    status: 'Needs review',
    theft: 'No record',
    ownership: '3 owners',
    accidents: '2 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 73,
    source: 'postgres-seed',
  },
  {
    vin: 'VF3ZJYN30CVASKN9F',
    make: 'Peugeot',
    model: '3008',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/ed/Peugeot_e-3008_Automesse_Ludwigsburg_2024_IMG_1537.jpg/500px-Peugeot_e-3008_Automesse_Ludwigsburg_2024_IMG_1537.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2015,
    status: 'Needs review',
    theft: 'No record',
    ownership: '3 owners',
    accidents: '2 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 74,
    source: 'postgres-seed',
  },
  {
    vin: 'YV1WH6BV7AA05K5MX',
    make: 'Volvo',
    model: 'XC60',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/1a/2018_Volvo_XC60_R-Design_D5_P-Pulse_2.0_Front.jpg/500px-2018_Volvo_XC60_R-Design_D5_P-Pulse_2.0_Front.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2013,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 94,
    source: 'postgres-seed',
  },
  {
    vin: '5YJ18NW93ECSNM91H',
    make: 'Tesla',
    model: 'Model 3',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Tesla_Model_3_%282023%29_Autofr%C3%BChling_Ulm_IMG_9282.jpg/500px-Tesla_Model_3_%282023%29_Autofr%C3%BChling_Ulm_IMG_9282.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2017,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 95,
    source: 'postgres-seed',
  },
  {
    vin: '1J4UD996S24YD9TWE',
    make: 'Jeep',
    model: 'Grand Cherokee',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/6/6c/2022_Jeep_Grand_Cherokee_Summit_Reserve_4x4_in_Bright_White%2C_Front_Left%2C_01-16-2022.jpg/500px-2022_Jeep_Grand_Cherokee_Summit_Reserve_4x4_in_Bright_White%2C_Front_Left%2C_01-16-2022.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2005,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '1 reported incident',
    mileage: 'Mileage appears consistent',
    score: 88,
    source: 'postgres-seed',
  },
  {
    vin: '1G1PD0LUR6C3TZ7FS',
    make: 'Chevrolet',
    model: 'Cruze',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/b/b4/2017_Chevrolet_Cruze_LT_in_Arctic_Blue_Metallic%2C_Front_Left.jpg/500px-2017_Chevrolet_Cruze_LT_in_Arctic_Blue_Metallic%2C_Front_Left.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2009,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '1 reported incident',
    mileage: 'Mileage appears consistent',
    score: 89,
    source: 'postgres-seed',
  },
  {
    vin: 'JTD9G5GBMDA0XUGHP',
    make: 'Toyota',
    model: 'Corolla Fielder',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/f/fe/Toyota_Corolla_Hybrid_%28E210%29_IMG_4338.jpg/500px-Toyota_Corolla_Hybrid_%28E210%29_IMG_4338.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2016,
    status: 'Needs review',
    theft: 'Flagged in one source',
    ownership: '2 owners',
    accidents: '3 reported incidents',
    mileage: 'Mileage varies from records',
    score: 47,
    source: 'postgres-seed',
  },
  {
    vin: 'JTE6E3N0NDUA43PSL',
    make: 'Toyota',
    model: 'Land Cruiser Prado',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/e8/2024_Toyota_Land_Cruiser_250_VX_in_Platinum_White_Pearl_Mica%2C_front_left.jpg/500px-2024_Toyota_Land_Cruiser_250_VX_in_Platinum_White_Pearl_Mica%2C_front_left.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2016,
    status: 'Verified',
    theft: 'No record',
    ownership: '3 owners',
    accidents: '1 reported incident',
    mileage: 'Mileage appears consistent',
    score: 81,
    source: 'postgres-seed',
  },
  {
    vin: 'JTM4PV7WSK23F1NVV',
    make: 'Toyota',
    model: 'RAV4',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/2d/2024_Toyota_RAV4_Prime_XSE_Premium_in_Silver_Sky_with_Midnight_Black_roof%2C_front_left.jpg/500px-2024_Toyota_RAV4_Prime_XSE_Premium_in_Silver_Sky_with_Midnight_Black_roof%2C_front_left.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2022,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '1 reported incident',
    mileage: 'Mileage appears consistent',
    score: 84,
    source: 'postgres-seed',
  },
  {
    vin: 'JT20ZD27L8GCHJURD',
    make: 'Toyota',
    model: 'Hilux',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/1b/2016_Toyota_HiLux_Invincible_D-4D_4WD_2.4_Front.jpg/500px-2016_Toyota_HiLux_Invincible_D-4D_4WD_2.4_Front.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2011,
    status: 'Verified',
    theft: 'No record',
    ownership: '3 owners',
    accidents: '0 reported incidents',
    mileage: 'Mileage varies from records',
    score: 83,
    source: 'postgres-seed',
  },
  {
    vin: 'JTN2RT54FKZFR6DHW',
    make: 'Toyota',
    model: 'Vitz',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/3e/2020_Toyota_Yaris_Design_HEV_CVT_1.5_Front.jpg/500px-2020_Toyota_Yaris_Design_HEV_CVT_1.5_Front.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2022,
    status: 'Verified',
    theft: 'No record',
    ownership: '3 owners',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 91,
    source: 'postgres-seed',
  },
  {
    vin: 'JN11KU9DX8KW3H189',
    make: 'Nissan',
    model: 'X-Trail',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/35/Nissan_X-Trail_%28T33%29_1X7A7179.jpg/500px-Nissan_X-Trail_%28T33%29_1X7A7179.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2011,
    status: 'Needs review',
    theft: 'No record',
    ownership: '4 owners',
    accidents: '2 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 74,
    source: 'postgres-seed',
  },
  {
    vin: 'JN8BB3WLV6DM1MHPK',
    make: 'Nissan',
    model: 'Note',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/41/2020-2024_Nissan_Note_S.jpg/500px-2020-2024_Nissan_Note_S.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2009,
    status: 'Needs review',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '2 reported incidents',
    mileage: 'Mileage varies from records',
    score: 73,
    source: 'postgres-seed',
  },
  {
    vin: 'SJNB9AUTBJE4GVRFE',
    make: 'Nissan',
    model: 'Navara',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/e9/2018_Nissan_Navara_Tekna_DCi_Automatic_2.3.jpg/500px-2018_Nissan_Navara_Tekna_DCi_Automatic_2.3.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2021,
    status: 'Needs review',
    theft: 'Flagged in one source',
    ownership: 'Single owner',
    accidents: '2 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 64,
    source: 'postgres-seed',
  },
  {
    vin: 'JHMCP807C3MMUDMT7',
    make: 'Honda',
    model: 'Fit',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/85/Honda_Jazz_Hybrid_Executive_%28IV%29_%E2%80%93_f_18102020.jpg/500px-Honda_Jazz_Hybrid_Executive_%28IV%29_%E2%80%93_f_18102020.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2006,
    status: 'Needs review',
    theft: 'Flagged in one source',
    ownership: '2 owners',
    accidents: '2 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 64,
    source: 'postgres-seed',
  },
  {
    vin: '1HG51RLLS36YGWLVJ',
    make: 'Honda',
    model: 'CR-V',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/1b/Honda_CR-V_e-HEV_Elegance_AWD_%28VI%29_%E2%80%93_f_14072024.jpg/500px-Honda_CR-V_e-HEV_Elegance_AWD_%28VI%29_%E2%80%93_f_14072024.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2006,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 97,
    source: 'postgres-seed',
  },
  {
    vin: 'JM1JZM246GKPWRYHV',
    make: 'Mazda',
    model: 'Demio',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/8d/Mazda2_Skyactiv-G_90_Homura_%28III%2C_2._Facelift%29_%E2%80%93_f_19052026.jpg/500px-Mazda2_Skyactiv-G_90_Homura_%28III%2C_2._Facelift%29_%E2%80%93_f_19052026.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2019,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '1 reported incident',
    mileage: 'Mileage varies from records',
    score: 85,
    source: 'postgres-seed',
  },
  {
    vin: 'JM7238GNCFTVS6HVX',
    make: 'Mazda',
    model: 'CX-5',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/a5/2024_Mazda_CX-5_2.5_S_Select_in_Platinum_Quartz_Metallic%2C_front_right.jpg/500px-2024_Mazda_CX-5_2.5_S_Select_in_Platinum_Quartz_Metallic%2C_front_right.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2018,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '1 reported incident',
    mileage: 'Mileage appears consistent',
    score: 84,
    source: 'postgres-seed',
  },
  {
    vin: 'JA49VMHN5KXB4GDGY',
    make: 'Mitsubishi',
    model: 'Outlander',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/35/2025_Mitsubishi_Outlander_PHEV_%28fourth_generation%29_IMG_3129.jpg/500px-2025_Mitsubishi_Outlander_PHEV_%28fourth_generation%29_IMG_3129.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2022,
    status: 'Needs review',
    theft: 'Flagged in one source',
    ownership: '2 owners',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 74,
    source: 'postgres-seed',
  },
  {
    vin: 'JA3CUCRKJAE84LWM2',
    make: 'Mitsubishi',
    model: 'Pajero',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/36/Mitsubishi_V98_Pajero_Long_Body_Super_Exceed_3200_DI-D.JPG/500px-Mitsubishi_V98_Pajero_Long_Body_Super_Exceed_3200_DI-D.JPG?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2013,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '0 reported incidents',
    mileage: 'Mileage varies from records',
    score: 89,
    source: 'postgres-seed',
  },
  {
    vin: 'JF1E80KDC3JA3S0M2',
    make: 'Subaru',
    model: 'Forester',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/48/Subaru_Forester_%28SL%29_e-BOXER_DSC_8811.jpg/500px-Subaru_Forester_%28SL%29_e-BOXER_DSC_8811.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2006,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 95,
    source: 'postgres-seed',
  },
  {
    vin: 'JF26N8XFVBM6CNLRV',
    make: 'Subaru',
    model: 'Impreza',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/45/Subaru_Impreza_%28GU%29_Automesse_Ludwigsburg_2024_IMG_1593.jpg/500px-Subaru_Impreza_%28GU%29_Automesse_Ludwigsburg_2024_IMG_1593.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2014,
    status: 'Needs review',
    theft: 'No record',
    ownership: '4 owners',
    accidents: '2 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 73,
    source: 'postgres-seed',
  },
  {
    vin: 'JS2MD1SWM5M9P2CUR',
    make: 'Suzuki',
    model: 'Swift',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/3d/Suzuki_Swift_%282024%29_hybrid_DSC_6076.jpg/500px-Suzuki_Swift_%282024%29_hybrid_DSC_6076.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2008,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '1 reported incident',
    mileage: 'Mileage appears consistent',
    score: 90,
    source: 'postgres-seed',
  },
  {
    vin: 'JS3LV240NE8AGGRKS',
    make: 'Suzuki',
    model: 'Vitara',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/7/7b/2024_Suzuki_Vitara_%284th_generation%29_DSC_6083.jpg/500px-2024_Suzuki_Vitara_%284th_generation%29_DSC_6083.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2017,
    status: 'Needs review',
    theft: 'No record',
    ownership: '3 owners',
    accidents: '3 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 69,
    source: 'postgres-seed',
  },
  {
    vin: 'JAAXV0MEAKCVRTUEK',
    make: 'Isuzu',
    model: 'D-Max',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/0/0d/Isuzu_D-Max_%28third_generation%29_autoMOBIL_T%C3%BCbingen_2025_DSC_2758.jpg/500px-Isuzu_D-Max_%28third_generation%29_autoMOBIL_T%C3%BCbingen_2025_DSC_2758.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2022,
    status: 'Needs review',
    theft: 'No record',
    ownership: '4 owners',
    accidents: '3 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 67,
    source: 'postgres-seed',
  },
  {
    vin: 'WVWRDYPXHKB1RCNCT',
    make: 'Volkswagen',
    model: 'Golf',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/8a/2020_Volkswagen_Golf_Style_1.5_Front.jpg/500px-2020_Volkswagen_Golf_Style_1.5_Front.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2022,
    status: 'Verified',
    theft: 'No record',
    ownership: '4 owners',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 89,
    source: 'postgres-seed',
  },
  {
    vin: '3VWN91YZ6DGYMF605',
    make: 'Volkswagen',
    model: 'Tiguan',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/ef/Volkswagen_Tiguan_III_IMG_8823_%28cropped%29.jpg/500px-Volkswagen_Tiguan_III_IMG_8823_%28cropped%29.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2016,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '0 reported incidents',
    mileage: 'Mileage varies from records',
    score: 92,
    source: 'postgres-seed',
  },
  {
    vin: 'WBAN8SKLNFL104CJU',
    make: 'BMW',
    model: '320i',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/9/91/BMW_G20_%282022%29_IMG_7316_%282%29.jpg/500px-BMW_G20_%282022%29_IMG_7316_%282%29.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2018,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 97,
    source: 'postgres-seed',
  },
  {
    vin: 'WBSP1UY3WHZVF6TCW',
    make: 'BMW',
    model: 'X5',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/f/f1/2019_BMW_X5_M50d_Automatic_3.0.jpg/500px-2019_BMW_X5_M50d_Automatic_3.0.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2020,
    status: 'Verified',
    theft: 'No record',
    ownership: 'New Import',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent (new import)',
    score: 98,
    source: 'postgres-seed',
  },
  {
    vin: 'WDDVPWPWPGWF8SN84',
    make: 'Mercedes-Benz',
    model: 'C-Class',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/b/be/Mercedes-Benz_W206_IMG_6380.jpg/500px-Mercedes-Benz_W206_IMG_6380.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2019,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '2 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 81,
    source: 'postgres-seed',
  },
  {
    vin: 'MBH61YP6WDN7H1SH0',
    make: 'Mercedes-Benz',
    model: 'GLC',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/2c/Mercedes-Benz_X254_1X7A6343.jpg/500px-Mercedes-Benz_X254_1X7A6343.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2016,
    status: 'Verified',
    theft: 'No record',
    ownership: '3 owners',
    accidents: '1 reported incident',
    mileage: 'Mileage appears consistent',
    score: 80,
    source: 'postgres-seed',
  },
  {
    vin: 'WAURXC3U3JY7UZT10',
    make: 'Audi',
    model: 'Q5',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/6/6d/Audi_Q5_2.0_TDI_quattro_S_line_%28GU%29_%E2%80%93_f_13102025.jpg/500px-Audi_Q5_2.0_TDI_quattro_S_line_%28GU%29_%E2%80%93_f_13102025.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2021,
    status: 'Verified',
    theft: 'No record',
    ownership: 'New Import',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent (new import)',
    score: 98,
    source: 'postgres-seed',
  },
  {
    vin: 'SALTAWCYN3B5WTA24',
    make: 'Land Rover',
    model: 'Discovery',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/e1/2018_Land_Rover_Discovery_Luxury_HSE_TD6_3.0_Front.jpg/500px-2018_Land_Rover_Discovery_Luxury_HSE_TD6_3.0_Front.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2006,
    status: 'Needs review',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '3 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 70,
    source: 'postgres-seed',
  },
  {
    vin: '1FA96ACGDCJDMN25F',
    make: 'Ford',
    model: 'Focus',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/7/75/2018_Ford_Focus_ST-Line_X_1.0.jpg/500px-2018_Ford_Focus_ST-Line_X_1.0.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2015,
    status: 'Verified',
    theft: 'No record',
    ownership: 'New Import',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent (new import)',
    score: 98,
    source: 'postgres-seed',
  },
  {
    vin: 'U1JNG9TUJD36RJJGL',
    make: 'Toyota',
    model: 'Prado',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/e8/2024_Toyota_Land_Cruiser_250_VX_in_Platinum_White_Pearl_Mica%2C_front_left.jpg/500px-2024_Toyota_Land_Cruiser_250_VX_in_Platinum_White_Pearl_Mica%2C_front_left.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2007,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '1 reported incident',
    mileage: 'Mileage varies from records',
    score: 89,
    source: 'postgres-seed',
  },
  {
    vin: 'SSRHAA972V2XMNJMY',
    make: 'Ford',
    model: 'Ranger',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/28/Ford_Ranger_%28T6%2C_P703%29_Wildtrak_IMG_7320.jpg/500px-Ford_Ranger_%28T6%2C_P703%29_Wildtrak_IMG_7320.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2012,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 88,
    source: 'postgres-seed',
  },
  {
    vin: '9VC9R0GU9GZPR1F33',
    make: 'Honda',
    model: 'Accord',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/26/2023_Honda_Accord_LX%2C_front_left%2C_07-13-2023.jpg/500px-2023_Honda_Accord_LX%2C_front_left%2C_07-13-2023.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2006,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 83,
    source: 'postgres-seed',
  },
  {
    vin: 'D9M2JY7SR7S9L351V',
    make: 'Mazda',
    model: 'CX-5',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/a5/2024_Mazda_CX-5_2.5_S_Select_in_Platinum_Quartz_Metallic%2C_front_right.jpg/500px-2024_Mazda_CX-5_2.5_S_Select_in_Platinum_Quartz_Metallic%2C_front_right.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2021,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 82,
    source: 'postgres-seed',
  },
  {
    vin: 'CTSA0NR7ERKPJN07A',
    make: 'Suzuki',
    model: 'Vitara',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/7/7b/2024_Suzuki_Vitara_%284th_generation%29_DSC_6083.jpg/500px-2024_Suzuki_Vitara_%284th_generation%29_DSC_6083.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2014,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '2 reported incidents',
    mileage: 'Mileage varies from records',
    score: 85,
    source: 'postgres-seed',
  },
  {
    vin: 'WMJNLXGK9GYT2EMHK',
    make: 'Chrysler',
    model: '300',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/c1/2016_Chrysler_300_Limited_AWD_front_4.22.19.jpg/500px-2016_Chrysler_300_Limited_AWD_front_4.22.19.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2008,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '0 reported incidents',
    mileage: 'Mileage jumped sharply between recordings with no supporting service history',
    score: 85,
    source: 'postgres-seed',
  },
  {
    vin: 'RLMD1PAMUG5783HTG',
    make: 'Nissan',
    model: 'Note',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/41/2020-2024_Nissan_Note_S.jpg/500px-2020-2024_Nissan_Note_S.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2022,
    status: 'Verified',
    theft: 'No record',
    ownership: '3 owners',
    accidents: '3 reported incidents',
    mileage: 'Mileage varies from records',
    score: 89,
    source: 'postgres-seed',
  },
  {
    vin: '99ENBUFTF3JHM1P8V',
    make: 'Isuzu',
    model: 'D-Max',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/0/0d/Isuzu_D-Max_%28third_generation%29_autoMOBIL_T%C3%BCbingen_2025_DSC_2758.jpg/500px-Isuzu_D-Max_%28third_generation%29_autoMOBIL_T%C3%BCbingen_2025_DSC_2758.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2014,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: 'No major accidents',
    mileage: 'Mileage appears consistent',
    score: 79,
    source: 'postgres-seed',
  },
  {
    vin: 'VXMNH3SYTBXZF3HBS',
    make: 'Volkswagen',
    model: 'Jetta',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/aa/2019_Volkswagen_Jetta_1.4T_R-Line_in_Haba%C3%B1ero_Orange_Metallic%2C_front_right.jpg/500px-2019_Volkswagen_Jetta_1.4T_R-Line_in_Haba%C3%B1ero_Orange_Metallic%2C_front_right.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2019,
    status: 'Needs review',
    theft: '1 stolen report',
    ownership: '2 owners',
    accidents: '0 reported incidents',
    mileage: 'Mileage jumped sharply between recordings with no supporting service history',
    score: 58,
    source: 'postgres-seed',
  },
  {
    vin: '7VB1JXASX6M68RS6A',
    make: 'Ford',
    model: 'Ranger',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/28/Ford_Ranger_%28T6%2C_P703%29_Wildtrak_IMG_7320.jpg/500px-Ford_Ranger_%28T6%2C_P703%29_Wildtrak_IMG_7320.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2005,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '1 reported incident',
    mileage: 'Mileage appears consistent',
    score: 82,
    source: 'postgres-seed',
  },
  {
    vin: 'E239RCR98PL93NLC7',
    make: 'Subaru',
    model: 'Impreza',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/45/Subaru_Impreza_%28GU%29_Automesse_Ludwigsburg_2024_IMG_1593.jpg/500px-Subaru_Impreza_%28GU%29_Automesse_Ludwigsburg_2024_IMG_1593.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2017,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: 'No major accidents',
    mileage: 'Mileage varies from records',
    score: 86,
    source: 'postgres-seed',
  },
  {
    vin: 'R10JR3XT33JHYHNHX',
    make: 'Audi',
    model: 'A4',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/35/Audi_A4_B9_sedans_%28FL%29_1X7A2441.jpg/500px-Audi_A4_B9_sedans_%28FL%29_1X7A2441.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2007,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 85,
    source: 'postgres-seed',
  },
  {
    vin: 'ADJZ4UA3NEFNBJZGB',
    make: 'Peugeot',
    model: '3008',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/ed/Peugeot_e-3008_Automesse_Ludwigsburg_2024_IMG_1537.jpg/500px-Peugeot_e-3008_Automesse_Ludwigsburg_2024_IMG_1537.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2019,
    status: 'Needs review',
    theft: 'Flagged - recovered vehicle',
    ownership: '2 owners',
    accidents: '2 reported incidents',
    mileage: 'Mileage varies from records',
    score: 57,
    source: 'postgres-seed',
  },
  {
    vin: 'KUYHPWWJZMTTM025R',
    make: 'BMW',
    model: '320i',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/9/91/BMW_G20_%282022%29_IMG_7316_%282%29.jpg/500px-BMW_G20_%282022%29_IMG_7316_%282%29.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2013,
    status: 'Verified',
    theft: 'No record',
    ownership: '3 owners',
    accidents: '3 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 78,
    source: 'postgres-seed',
  },
  {
    vin: 'UA7VG1MREEL71Z1MS',
    make: 'Suzuki',
    model: 'Swift',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/3d/Suzuki_Swift_%282024%29_hybrid_DSC_6076.jpg/500px-Suzuki_Swift_%282024%29_hybrid_DSC_6076.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2016,
    status: 'Verified',
    theft: 'No record',
    ownership: '3 owners',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 88,
    source: 'postgres-seed',
  },
  {
    vin: 'M576MLJV235NCGLZ3',
    make: 'Land Rover',
    model: 'Discovery',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/e1/2018_Land_Rover_Discovery_Luxury_HSE_TD6_3.0_Front.jpg/500px-2018_Land_Rover_Discovery_Luxury_HSE_TD6_3.0_Front.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2017,
    status: 'Needs review',
    theft: '1 stolen report',
    ownership: 'Single owner',
    accidents: '0 reported incidents',
    mileage: 'Mileage varies from records',
    score: 57,
    source: 'postgres-seed',
  },
  {
    vin: 'JL81PSECG41LAAHJX',
    make: 'Subaru',
    model: 'Forester',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/48/Subaru_Forester_%28SL%29_e-BOXER_DSC_8811.jpg/500px-Subaru_Forester_%28SL%29_e-BOXER_DSC_8811.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2023,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '3 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 87,
    source: 'postgres-seed',
  },
  {
    vin: 'VGBUUTE6613UKHC9G',
    make: 'Ford',
    model: 'Ranger',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/28/Ford_Ranger_%28T6%2C_P703%29_Wildtrak_IMG_7320.jpg/500px-Ford_Ranger_%28T6%2C_P703%29_Wildtrak_IMG_7320.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2023,
    status: 'Verified',
    theft: 'No record',
    ownership: '3 owners',
    accidents: '0 reported incidents',
    mileage: 'Mileage varies from records',
    score: 76,
    source: 'postgres-seed',
  },
  {
    vin: '9C86329JNFES52DG6',
    make: 'Nissan',
    model: 'X-Trail',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/35/Nissan_X-Trail_%28T33%29_1X7A7179.jpg/500px-Nissan_X-Trail_%28T33%29_1X7A7179.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2009,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '1 reported incident',
    mileage: 'Mileage appears consistent',
    score: 89,
    source: 'postgres-seed',
  },
  {
    vin: '9SHX2UZLXP6WR3R8J',
    make: 'Toyota',
    model: 'Corolla Fielder',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/f/fe/Toyota_Corolla_Hybrid_%28E210%29_IMG_4338.jpg/500px-Toyota_Corolla_Hybrid_%28E210%29_IMG_4338.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2019,
    status: 'Verified',
    theft: 'No record',
    ownership: '4 owners',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 89,
    source: 'postgres-seed',
  },
  {
    vin: '17L5JV3P1WBY41HXG',
    make: 'Toyota',
    model: 'Vitz',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/3e/2020_Toyota_Yaris_Design_HEV_CVT_1.5_Front.jpg/500px-2020_Toyota_Yaris_Design_HEV_CVT_1.5_Front.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2017,
    status: 'Verified',
    theft: 'No record',
    ownership: '4 owners',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 89,
    source: 'postgres-seed',
  },
  {
    vin: '1PMS318HX4ENMKRGY',
    make: 'BMW',
    model: '320i',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/9/91/BMW_G20_%282022%29_IMG_7316_%282%29.jpg/500px-BMW_G20_%282022%29_IMG_7316_%282%29.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2007,
    status: 'Needs review',
    theft: '1 stolen report',
    ownership: '4 owners',
    accidents: '0 reported incidents',
    mileage: 'Mileage varies from records',
    score: 68,
    source: 'postgres-seed',
  },
  {
    vin: 'FCKH6CCPL2PYEF754',
    make: 'Isuzu',
    model: 'D-Max',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/0/0d/Isuzu_D-Max_%28third_generation%29_autoMOBIL_T%C3%BCbingen_2025_DSC_2758.jpg/500px-Isuzu_D-Max_%28third_generation%29_autoMOBIL_T%C3%BCbingen_2025_DSC_2758.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2014,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 80,
    source: 'postgres-seed',
  },
  {
    vin: 'KPZBT4ZU61RHW3AJW',
    make: 'Subaru',
    model: 'Forester',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/48/Subaru_Forester_%28SL%29_e-BOXER_DSC_8811.jpg/500px-Subaru_Forester_%28SL%29_e-BOXER_DSC_8811.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2019,
    status: 'Verified',
    theft: 'No record',
    ownership: '4 owners',
    accidents: '3 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 77,
    source: 'postgres-seed',
  },
  {
    vin: '2L0FBZR9LX4V41UC8',
    make: 'Nissan',
    model: 'Navara',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/e9/2018_Nissan_Navara_Tekna_DCi_Automatic_2.3.jpg/500px-2018_Nissan_Navara_Tekna_DCi_Automatic_2.3.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2014,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 77,
    source: 'postgres-seed',
  },
  {
    vin: 'YEAJ1BZ0TU0RXB38W',
    make: 'Ford',
    model: 'Ranger',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/28/Ford_Ranger_%28T6%2C_P703%29_Wildtrak_IMG_7320.jpg/500px-Ford_Ranger_%28T6%2C_P703%29_Wildtrak_IMG_7320.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2024,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '3 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 90,
    source: 'postgres-seed',
  },
  {
    vin: 'U27ZL8XADAA9J25BC',
    make: 'Nissan',
    model: 'X-Trail',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/35/Nissan_X-Trail_%28T33%29_1X7A7179.jpg/500px-Nissan_X-Trail_%28T33%29_1X7A7179.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2010,
    status: 'Verified',
    theft: 'No record',
    ownership: '4 owners',
    accidents: '1 reported incident',
    mileage: 'Mileage varies from records',
    score: 79,
    source: 'postgres-seed',
  },
  {
    vin: 'ESLMADBYB3A1UMD0L',
    make: 'Chevrolet',
    model: 'Cruze',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/b/b4/2017_Chevrolet_Cruze_LT_in_Arctic_Blue_Metallic%2C_Front_Left.jpg/500px-2017_Chevrolet_Cruze_LT_in_Arctic_Blue_Metallic%2C_Front_Left.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2008,
    status: 'Needs review',
    theft: '1 stolen report',
    ownership: '2 owners',
    accidents: 'No major accidents',
    mileage: 'Mileage varies from records',
    score: 72,
    source: 'postgres-seed',
  },
  {
    vin: 'KRVRLKDRE4RXR2UKP',
    make: 'Suzuki',
    model: 'Vitara',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/7/7b/2024_Suzuki_Vitara_%284th_generation%29_DSC_6083.jpg/500px-2024_Suzuki_Vitara_%284th_generation%29_DSC_6083.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2022,
    status: 'Verified',
    theft: 'No record',
    ownership: '3 owners',
    accidents: '1 reported incident',
    mileage: 'Mileage appears consistent',
    score: 83,
    source: 'postgres-seed',
  },
  {
    vin: 'ZB2VMGLVC0AKFTTLU',
    make: 'Volkswagen',
    model: 'Jetta',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/aa/2019_Volkswagen_Jetta_1.4T_R-Line_in_Haba%C3%B1ero_Orange_Metallic%2C_front_right.jpg/500px-2019_Volkswagen_Jetta_1.4T_R-Line_in_Haba%C3%B1ero_Orange_Metallic%2C_front_right.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2008,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '2 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 87,
    source: 'postgres-seed',
  },
  {
    vin: 'MCNT37LYR330RJY9D',
    make: 'Kia',
    model: 'Sportage',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/5/5d/2025_Kia_Sportage_S_front_only.jpg/500px-2025_Kia_Sportage_S_front_only.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2021,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 80,
    source: 'postgres-seed',
  },
  {
    vin: '5MFBL17GYUYMDCSYM',
    make: 'Subaru',
    model: 'Impreza',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/45/Subaru_Impreza_%28GU%29_Automesse_Ludwigsburg_2024_IMG_1593.jpg/500px-Subaru_Impreza_%28GU%29_Automesse_Ludwigsburg_2024_IMG_1593.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2014,
    status: 'Verified',
    theft: 'No record',
    ownership: '4 owners',
    accidents: 'No major accidents',
    mileage: 'Odometer rollback suspected - readings decreased between service records',
    score: 78,
    source: 'postgres-seed',
  },
  {
    vin: 'D22TBMXE6LZY6R15C',
    make: 'Peugeot',
    model: '3008',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/ed/Peugeot_e-3008_Automesse_Ludwigsburg_2024_IMG_1537.jpg/500px-Peugeot_e-3008_Automesse_Ludwigsburg_2024_IMG_1537.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2022,
    status: 'Verified',
    theft: 'No record',
    ownership: 'New Import',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent (new import)',
    score: 98,
    source: 'postgres-seed',
  },
  {
    vin: 'P9PXFHCMAC8L79DFW',
    make: 'Chevrolet',
    model: 'Cruze',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/b/b4/2017_Chevrolet_Cruze_LT_in_Arctic_Blue_Metallic%2C_Front_Left.jpg/500px-2017_Chevrolet_Cruze_LT_in_Arctic_Blue_Metallic%2C_Front_Left.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2007,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: 'No major accidents',
    mileage: 'Mileage appears consistent',
    score: 84,
    source: 'postgres-seed',
  },
  {
    vin: 'LRJJFTWFSBGBJE3L7',
    make: 'Toyota',
    model: 'Prado',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/e8/2024_Toyota_Land_Cruiser_250_VX_in_Platinum_White_Pearl_Mica%2C_front_left.jpg/500px-2024_Toyota_Land_Cruiser_250_VX_in_Platinum_White_Pearl_Mica%2C_front_left.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2018,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: 'No major accidents',
    mileage: 'Mileage appears consistent',
    score: 78,
    source: 'postgres-seed',
  },
  {
    vin: 'CV5AMBECJA6HBKHZB',
    make: 'Volkswagen',
    model: 'Jetta',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/aa/2019_Volkswagen_Jetta_1.4T_R-Line_in_Haba%C3%B1ero_Orange_Metallic%2C_front_right.jpg/500px-2019_Volkswagen_Jetta_1.4T_R-Line_in_Haba%C3%B1ero_Orange_Metallic%2C_front_right.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2018,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 81,
    source: 'postgres-seed',
  },
  {
    vin: 'H4V19SNVERSXGN1UZ',
    make: 'Honda',
    model: 'Accord',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/26/2023_Honda_Accord_LX%2C_front_left%2C_07-13-2023.jpg/500px-2023_Honda_Accord_LX%2C_front_left%2C_07-13-2023.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2007,
    status: 'Verified',
    theft: 'No record',
    ownership: '4 owners',
    accidents: '2 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 87,
    source: 'postgres-seed',
  },
  {
    vin: 'XAH1TRNZBDZARKTN8',
    make: 'Toyota',
    model: 'Corolla Fielder',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/f/fe/Toyota_Corolla_Hybrid_%28E210%29_IMG_4338.jpg/500px-Toyota_Corolla_Hybrid_%28E210%29_IMG_4338.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2005,
    status: 'Verified',
    theft: 'No record',
    ownership: '3 owners',
    accidents: '2 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 88,
    source: 'postgres-seed',
  },
  {
    vin: '80H3FB0ZAZS6WTWVX',
    make: 'Suzuki',
    model: 'Swift',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/3d/Suzuki_Swift_%282024%29_hybrid_DSC_6076.jpg/500px-Suzuki_Swift_%282024%29_hybrid_DSC_6076.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2024,
    status: 'Needs review',
    theft: 'Flagged in one source',
    ownership: '4 owners',
    accidents: 'No major accidents',
    mileage: 'Mileage varies from records',
    score: 63,
    source: 'postgres-seed',
  },
  {
    vin: '4HUCKNJH4DKFHGRWA',
    make: 'Honda',
    model: 'Accord',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/26/2023_Honda_Accord_LX%2C_front_left%2C_07-13-2023.jpg/500px-2023_Honda_Accord_LX%2C_front_left%2C_07-13-2023.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2022,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: 'No major accidents',
    mileage: 'Mileage appears consistent',
    score: 85,
    source: 'postgres-seed',
  },
  {
    vin: '7V2GUJ1WP5ZZ8NAS7',
    make: 'Mercedes-Benz',
    model: 'GLC',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/2c/Mercedes-Benz_X254_1X7A6343.jpg/500px-Mercedes-Benz_X254_1X7A6343.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2017,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 79,
    source: 'postgres-seed',
  },
  {
    vin: 'BBMNAEK5DL7C2PXCV',
    make: 'Audi',
    model: 'A4',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/35/Audi_A4_B9_sedans_%28FL%29_1X7A2441.jpg/500px-Audi_A4_B9_sedans_%28FL%29_1X7A2441.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2009,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '1 reported incident',
    mileage: 'Mileage appears consistent',
    score: 87,
    source: 'postgres-seed',
  },
  {
    vin: '6GGWHRY8R6F1G9P1W',
    make: 'Nissan',
    model: 'Navara',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/e9/2018_Nissan_Navara_Tekna_DCi_Automatic_2.3.jpg/500px-2018_Nissan_Navara_Tekna_DCi_Automatic_2.3.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2010,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 86,
    source: 'postgres-seed',
  },
  {
    vin: 'NNBJY5DEPC8TE75S9',
    make: 'Toyota',
    model: 'Hilux',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/1b/2016_Toyota_HiLux_Invincible_D-4D_4WD_2.4_Front.jpg/500px-2016_Toyota_HiLux_Invincible_D-4D_4WD_2.4_Front.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2009,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 86,
    source: 'postgres-seed',
  },
  {
    vin: '95919C6G8EL3HL2P3',
    make: 'Land Rover',
    model: 'Discovery',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/e1/2018_Land_Rover_Discovery_Luxury_HSE_TD6_3.0_Front.jpg/500px-2018_Land_Rover_Discovery_Luxury_HSE_TD6_3.0_Front.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2016,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '3 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 79,
    source: 'postgres-seed',
  },
  {
    vin: '9UY75RPVG2NAXS0L9',
    make: 'Nissan',
    model: 'Note',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/41/2020-2024_Nissan_Note_S.jpg/500px-2020-2024_Nissan_Note_S.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2010,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '0 reported incidents',
    mileage: 'Mileage varies from records',
    score: 81,
    source: 'postgres-seed',
  },
  {
    vin: 'W06HVKZW9KUU9KS5K',
    make: 'Subaru',
    model: 'Impreza',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/45/Subaru_Impreza_%28GU%29_Automesse_Ludwigsburg_2024_IMG_1593.jpg/500px-Subaru_Impreza_%28GU%29_Automesse_Ludwigsburg_2024_IMG_1593.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2019,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '3 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 81,
    source: 'postgres-seed',
  },
  {
    vin: 'U47YV2FUJRDNMU7PG',
    make: 'Peugeot',
    model: '3008',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/ed/Peugeot_e-3008_Automesse_Ludwigsburg_2024_IMG_1537.jpg/500px-Peugeot_e-3008_Automesse_Ludwigsburg_2024_IMG_1537.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2005,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '1 reported incident',
    mileage: 'Mileage appears consistent',
    score: 90,
    source: 'postgres-seed',
  },
  {
    vin: 'GG8V3DMW7GSC6DS09',
    make: 'Land Rover',
    model: 'Discovery',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/e1/2018_Land_Rover_Discovery_Luxury_HSE_TD6_3.0_Front.jpg/500px-2018_Land_Rover_Discovery_Luxury_HSE_TD6_3.0_Front.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2015,
    status: 'Needs review',
    theft: 'Flagged - recovered vehicle',
    ownership: '3 owners',
    accidents: '2 reported incidents',
    mileage: 'Mileage varies from records',
    score: 68,
    source: 'postgres-seed',
  },
  {
    vin: 'HHVMM21FTJ48EJYE5',
    make: 'Nissan',
    model: 'Navara',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/e9/2018_Nissan_Navara_Tekna_DCi_Automatic_2.3.jpg/500px-2018_Nissan_Navara_Tekna_DCi_Automatic_2.3.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2006,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '2 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 84,
    source: 'postgres-seed',
  },
  {
    vin: 'J80GCL2DFUEF9MHWU',
    make: 'BMW',
    model: 'X5',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/f/f1/2019_BMW_X5_M50d_Automatic_3.0.jpg/500px-2019_BMW_X5_M50d_Automatic_3.0.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2005,
    status: 'Verified',
    theft: 'No record',
    ownership: '3 owners',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 85,
    source: 'postgres-seed',
  },
  {
    vin: '32JVMGFKP98EZSMH3',
    make: 'Volkswagen',
    model: 'Golf',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/8a/2020_Volkswagen_Golf_Style_1.5_Front.jpg/500px-2020_Volkswagen_Golf_Style_1.5_Front.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2016,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '1 reported incident',
    mileage: 'Mileage appears consistent',
    score: 82,
    source: 'postgres-seed',
  },
  {
    vin: 'KFT9MABT7S38DJ37V',
    make: 'Mitsubishi',
    model: 'Outlander',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/35/2025_Mitsubishi_Outlander_PHEV_%28fourth_generation%29_IMG_3129.jpg/500px-2025_Mitsubishi_Outlander_PHEV_%28fourth_generation%29_IMG_3129.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2011,
    status: 'Verified',
    theft: 'No record',
    ownership: '3 owners',
    accidents: '1 reported incident',
    mileage: 'Mileage varies from records',
    score: 89,
    source: 'postgres-seed',
  },
  {
    vin: 'AGY35Z0M3YTVYY2ZX',
    make: 'Nissan',
    model: 'Navara',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/e9/2018_Nissan_Navara_Tekna_DCi_Automatic_2.3.jpg/500px-2018_Nissan_Navara_Tekna_DCi_Automatic_2.3.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2011,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '0 reported incidents',
    mileage: 'Mileage jumped sharply between recordings with no supporting service history',
    score: 85,
    source: 'postgres-seed',
  },
  {
    vin: 'TZVSB6CHV96V5HZ46',
    make: 'Volvo',
    model: 'XC60',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/1a/2018_Volvo_XC60_R-Design_D5_P-Pulse_2.0_Front.jpg/500px-2018_Volvo_XC60_R-Design_D5_P-Pulse_2.0_Front.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2022,
    status: 'Verified',
    theft: 'No record',
    ownership: '4 owners',
    accidents: '3 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 81,
    source: 'postgres-seed',
  },
  {
    vin: 'LDNMF6GJL0GC6Z8FP',
    make: 'Ford',
    model: 'Ranger',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/28/Ford_Ranger_%28T6%2C_P703%29_Wildtrak_IMG_7320.jpg/500px-Ford_Ranger_%28T6%2C_P703%29_Wildtrak_IMG_7320.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2014,
    status: 'Verified',
    theft: 'No record',
    ownership: '3 owners',
    accidents: '1 reported incident',
    mileage: 'Mileage appears consistent',
    score: 81,
    source: 'postgres-seed',
  },
  {
    vin: '7VZGNVB2VFZ8WFVSL',
    make: 'Honda',
    model: 'CR-V',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/1b/Honda_CR-V_e-HEV_Elegance_AWD_%28VI%29_%E2%80%93_f_14072024.jpg/500px-Honda_CR-V_e-HEV_Elegance_AWD_%28VI%29_%E2%80%93_f_14072024.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2005,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '3 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 87,
    source: 'postgres-seed',
  },
  {
    vin: 'GMTB3Y8JU92XGYDPR',
    make: 'Honda',
    model: 'Fit',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/85/Honda_Jazz_Hybrid_Executive_%28IV%29_%E2%80%93_f_18102020.jpg/500px-Honda_Jazz_Hybrid_Executive_%28IV%29_%E2%80%93_f_18102020.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2015,
    status: 'Needs review',
    theft: 'Flagged - recovered vehicle',
    ownership: 'Single owner',
    accidents: 'No major accidents',
    mileage: 'Mileage varies from records',
    score: 62,
    source: 'postgres-seed',
  },
  {
    vin: '5D722CD1S1DN46FLA',
    make: 'Volvo',
    model: 'XC60',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/1a/2018_Volvo_XC60_R-Design_D5_P-Pulse_2.0_Front.jpg/500px-2018_Volvo_XC60_R-Design_D5_P-Pulse_2.0_Front.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2019,
    status: 'Verified',
    theft: 'No record',
    ownership: 'New Import',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent (new import)',
    score: 98,
    source: 'postgres-seed',
  },
  {
    vin: 'U87KWCK5XCXRYZC5H',
    make: 'Ford',
    model: 'Focus',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/7/75/2018_Ford_Focus_ST-Line_X_1.0.jpg/500px-2018_Ford_Focus_ST-Line_X_1.0.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2012,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '3 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 79,
    source: 'postgres-seed',
  },
  {
    vin: '9JJZNG5CB2FP46464',
    make: 'Toyota',
    model: 'Hilux',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/1b/2016_Toyota_HiLux_Invincible_D-4D_4WD_2.4_Front.jpg/500px-2016_Toyota_HiLux_Invincible_D-4D_4WD_2.4_Front.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2023,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: 'No major accidents',
    mileage: 'Odometer reading unchanged across multiple recorded services',
    score: 76,
    source: 'postgres-seed',
  },
  {
    vin: 'LYJED0HP856K88EUM',
    make: 'Honda',
    model: 'CR-V',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/1b/Honda_CR-V_e-HEV_Elegance_AWD_%28VI%29_%E2%80%93_f_14072024.jpg/500px-Honda_CR-V_e-HEV_Elegance_AWD_%28VI%29_%E2%80%93_f_14072024.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2020,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '1 reported incident',
    mileage: 'Mileage varies from records',
    score: 89,
    source: 'postgres-seed',
  },
  {
    vin: 'XN1FDA2M95RZ8KGJ5',
    make: 'Mitsubishi',
    model: 'Pajero',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/36/Mitsubishi_V98_Pajero_Long_Body_Super_Exceed_3200_DI-D.JPG/500px-Mitsubishi_V98_Pajero_Long_Body_Super_Exceed_3200_DI-D.JPG?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2009,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '3 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 78,
    source: 'postgres-seed',
  },
  {
    vin: 'YB66ZD7ATA7P411ML',
    make: 'Volkswagen',
    model: 'Golf',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/8a/2020_Volkswagen_Golf_Style_1.5_Front.jpg/500px-2020_Volkswagen_Golf_Style_1.5_Front.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2022,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '3 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 79,
    source: 'postgres-seed',
  },
  {
    vin: 'XPY7CZ677JH5RTK0X',
    make: 'Toyota',
    model: 'Camry',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ac/2018_Toyota_Camry_%28ASV70R%29_Ascent_sedan_%282018-08-27%29_01.jpg/500px-2018_Toyota_Camry_%28ASV70R%29_Ascent_sedan_%282018-08-27%29_01.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2022,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 88,
    source: 'postgres-seed',
  },
  {
    vin: 'UM2S5JL2KK7368FBP',
    make: 'Honda',
    model: 'CR-V',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/1b/Honda_CR-V_e-HEV_Elegance_AWD_%28VI%29_%E2%80%93_f_14072024.jpg/500px-Honda_CR-V_e-HEV_Elegance_AWD_%28VI%29_%E2%80%93_f_14072024.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2009,
    status: 'Verified',
    theft: 'No record',
    ownership: '4 owners',
    accidents: 'No major accidents',
    mileage: 'Mileage appears consistent',
    score: 80,
    source: 'postgres-seed',
  },
  {
    vin: 'CP41S0RZJYHFAK9YS',
    make: 'Subaru',
    model: 'Forester',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/48/Subaru_Forester_%28SL%29_e-BOXER_DSC_8811.jpg/500px-Subaru_Forester_%28SL%29_e-BOXER_DSC_8811.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2007,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '3 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 76,
    source: 'postgres-seed',
  },
  {
    vin: 'UHTU7DGYR2BL5SK67',
    make: 'Toyota',
    model: 'Corolla Fielder',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/f/fe/Toyota_Corolla_Hybrid_%28E210%29_IMG_4338.jpg/500px-Toyota_Corolla_Hybrid_%28E210%29_IMG_4338.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2021,
    status: 'Verified',
    theft: 'No record',
    ownership: '4 owners',
    accidents: '3 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 84,
    source: 'postgres-seed',
  },
  {
    vin: '0X0Z6K5CNU96S7X9V',
    make: 'Volkswagen',
    model: 'Jetta',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/aa/2019_Volkswagen_Jetta_1.4T_R-Line_in_Haba%C3%B1ero_Orange_Metallic%2C_front_right.jpg/500px-2019_Volkswagen_Jetta_1.4T_R-Line_in_Haba%C3%B1ero_Orange_Metallic%2C_front_right.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2013,
    status: 'Verified',
    theft: 'No record',
    ownership: '3 owners',
    accidents: 'No major accidents',
    mileage: 'Mileage varies from records',
    score: 78,
    source: 'postgres-seed',
  },
  {
    vin: 'N90SS9C2RCVX4MNJY',
    make: 'BMW',
    model: '320i',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/9/91/BMW_G20_%282022%29_IMG_7316_%282%29.jpg/500px-BMW_G20_%282022%29_IMG_7316_%282%29.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2016,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 88,
    source: 'postgres-seed',
  },
  {
    vin: 'Y71A7TAY5XUBKPJ15',
    make: 'Toyota',
    model: 'Vitz',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/3e/2020_Toyota_Yaris_Design_HEV_CVT_1.5_Front.jpg/500px-2020_Toyota_Yaris_Design_HEV_CVT_1.5_Front.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2009,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '2 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 81,
    source: 'postgres-seed',
  },
  {
    vin: 'AR5H2SUW0Y62J0CJ5',
    make: 'Volkswagen',
    model: 'Golf',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/8a/2020_Volkswagen_Golf_Style_1.5_Front.jpg/500px-2020_Volkswagen_Golf_Style_1.5_Front.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2016,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 82,
    source: 'postgres-seed',
  },
  {
    vin: 'W0FF4R2WBCYJ4LXZC',
    make: 'Chrysler',
    model: '300',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/c1/2016_Chrysler_300_Limited_AWD_front_4.22.19.jpg/500px-2016_Chrysler_300_Limited_AWD_front_4.22.19.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2019,
    status: 'Verified',
    theft: 'No record',
    ownership: '4 owners',
    accidents: '2 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 81,
    source: 'postgres-seed',
  },
  {
    vin: 'F4DXTTT7U68VGCVJW',
    make: 'Volvo',
    model: 'XC60',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/1a/2018_Volvo_XC60_R-Design_D5_P-Pulse_2.0_Front.jpg/500px-2018_Volvo_XC60_R-Design_D5_P-Pulse_2.0_Front.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2020,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 87,
    source: 'postgres-seed',
  },
  {
    vin: '6MBSBFJSXS388W5EV',
    make: 'Nissan',
    model: 'Navara',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/e9/2018_Nissan_Navara_Tekna_DCi_Automatic_2.3.jpg/500px-2018_Nissan_Navara_Tekna_DCi_Automatic_2.3.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2007,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: 'No major accidents',
    mileage: 'Mileage appears consistent',
    score: 79,
    source: 'postgres-seed',
  },
  {
    vin: 'JBDGB5J8GYNRDDFXH',
    make: 'Chevrolet',
    model: 'Cruze',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/b/b4/2017_Chevrolet_Cruze_LT_in_Arctic_Blue_Metallic%2C_Front_Left.jpg/500px-2017_Chevrolet_Cruze_LT_in_Arctic_Blue_Metallic%2C_Front_Left.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2016,
    status: 'Verified',
    theft: 'No record',
    ownership: '3 owners',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 77,
    source: 'postgres-seed',
  },
  {
    vin: 'FG5U25KLBA11HHS5B',
    make: 'Toyota',
    model: 'Corolla Fielder',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/f/fe/Toyota_Corolla_Hybrid_%28E210%29_IMG_4338.jpg/500px-Toyota_Corolla_Hybrid_%28E210%29_IMG_4338.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2018,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 81,
    source: 'postgres-seed',
  },
  {
    vin: 'K1S4679YU4RKX0SD7',
    make: 'Mercedes-Benz',
    model: 'C-Class',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/b/be/Mercedes-Benz_W206_IMG_6380.jpg/500px-Mercedes-Benz_W206_IMG_6380.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2018,
    status: 'Needs review',
    theft: '1 stolen report',
    ownership: 'Single owner',
    accidents: 'No major accidents',
    mileage: 'Odometer reading unchanged across multiple recorded services',
    score: 50,
    source: 'postgres-seed',
  },
  {
    vin: '455KR8T57DS4S31VN',
    make: 'Isuzu',
    model: 'D-Max',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/0/0d/Isuzu_D-Max_%28third_generation%29_autoMOBIL_T%C3%BCbingen_2025_DSC_2758.jpg/500px-Isuzu_D-Max_%28third_generation%29_autoMOBIL_T%C3%BCbingen_2025_DSC_2758.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2019,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 82,
    source: 'postgres-seed',
  },
  {
    vin: 'Z1J77J732UT4GY3FT',
    make: 'Honda',
    model: 'CR-V',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/1b/Honda_CR-V_e-HEV_Elegance_AWD_%28VI%29_%E2%80%93_f_14072024.jpg/500px-Honda_CR-V_e-HEV_Elegance_AWD_%28VI%29_%E2%80%93_f_14072024.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2016,
    status: 'Verified',
    theft: 'No record',
    ownership: '4 owners',
    accidents: '3 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 82,
    source: 'postgres-seed',
  },
  {
    vin: 'SCTZNF3MGS4DSDHU2',
    make: 'Honda',
    model: 'Civic',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/1a/Honda_Civic_e-HEV_Sport_%28XI%29_%E2%80%93_f_30062024.jpg/500px-Honda_Civic_e-HEV_Sport_%28XI%29_%E2%80%93_f_30062024.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2009,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: 'No major accidents',
    mileage: 'Mileage appears consistent',
    score: 78,
    source: 'postgres-seed',
  },
  {
    vin: 'DSDB1297VPDGSFH05',
    make: 'Mitsubishi',
    model: 'Outlander',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/35/2025_Mitsubishi_Outlander_PHEV_%28fourth_generation%29_IMG_3129.jpg/500px-2025_Mitsubishi_Outlander_PHEV_%28fourth_generation%29_IMG_3129.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2020,
    status: 'Verified',
    theft: 'No record',
    ownership: '3 owners',
    accidents: '1 reported incident',
    mileage: 'Mileage appears consistent',
    score: 86,
    source: 'postgres-seed',
  },
  {
    vin: 'X1BS1U24PZWXU649F',
    make: 'Jeep',
    model: 'Grand Cherokee',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/6/6c/2022_Jeep_Grand_Cherokee_Summit_Reserve_4x4_in_Bright_White%2C_Front_Left%2C_01-16-2022.jpg/500px-2022_Jeep_Grand_Cherokee_Summit_Reserve_4x4_in_Bright_White%2C_Front_Left%2C_01-16-2022.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2017,
    status: 'Verified',
    theft: 'No record',
    ownership: '4 owners',
    accidents: 'No major accidents',
    mileage: 'Mileage appears consistent',
    score: 90,
    source: 'postgres-seed',
  },
  {
    vin: '2FT438R78V7F45UTR',
    make: 'Honda',
    model: 'CR-V',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/1b/Honda_CR-V_e-HEV_Elegance_AWD_%28VI%29_%E2%80%93_f_14072024.jpg/500px-Honda_CR-V_e-HEV_Elegance_AWD_%28VI%29_%E2%80%93_f_14072024.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2019,
    status: 'Needs review',
    theft: 'Flagged in one source',
    ownership: '2 owners',
    accidents: '0 reported incidents',
    mileage: 'Gap detected between mileage recordings - unexplained interval with no data',
    score: 59,
    source: 'postgres-seed',
  },
  {
    vin: '4RZKEN7D65D60472N',
    make: 'Jeep',
    model: 'Grand Cherokee',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/6/6c/2022_Jeep_Grand_Cherokee_Summit_Reserve_4x4_in_Bright_White%2C_Front_Left%2C_01-16-2022.jpg/500px-2022_Jeep_Grand_Cherokee_Summit_Reserve_4x4_in_Bright_White%2C_Front_Left%2C_01-16-2022.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2009,
    status: 'Verified',
    theft: 'No record',
    ownership: '4 owners',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 77,
    source: 'postgres-seed',
  },
  {
    vin: 'U5ZVAZAG319ZDMSSL',
    make: 'Mercedes-Benz',
    model: 'C-Class',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/b/be/Mercedes-Benz_W206_IMG_6380.jpg/500px-Mercedes-Benz_W206_IMG_6380.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2024,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: 'No major accidents',
    mileage: 'Mileage appears consistent',
    score: 82,
    source: 'postgres-seed',
  },
  {
    vin: 'DMFXD3PA5LJYYGUTK',
    make: 'Toyota',
    model: 'Prado',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/e8/2024_Toyota_Land_Cruiser_250_VX_in_Platinum_White_Pearl_Mica%2C_front_left.jpg/500px-2024_Toyota_Land_Cruiser_250_VX_in_Platinum_White_Pearl_Mica%2C_front_left.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2006,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 78,
    source: 'postgres-seed',
  },
  {
    vin: 'ZCU21420DS3EJS8E1',
    make: 'Honda',
    model: 'Accord',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/26/2023_Honda_Accord_LX%2C_front_left%2C_07-13-2023.jpg/500px-2023_Honda_Accord_LX%2C_front_left%2C_07-13-2023.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2013,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '2 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 85,
    source: 'postgres-seed',
  },
  {
    vin: 'ZN97KVGT9GGZV3L0K',
    make: 'Honda',
    model: 'Civic',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/1a/Honda_Civic_e-HEV_Sport_%28XI%29_%E2%80%93_f_30062024.jpg/500px-Honda_Civic_e-HEV_Sport_%28XI%29_%E2%80%93_f_30062024.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2009,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '3 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 87,
    source: 'postgres-seed',
  },
  {
    vin: 'ABZYH1YTX29LU4WUJ',
    make: 'Suzuki',
    model: 'Swift',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/3d/Suzuki_Swift_%282024%29_hybrid_DSC_6076.jpg/500px-Suzuki_Swift_%282024%29_hybrid_DSC_6076.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2016,
    status: 'Verified',
    theft: 'No record',
    ownership: '3 owners',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 90,
    source: 'postgres-seed',
  },
  {
    vin: 'FDCKJL2YCB3GFU9R4',
    make: 'Audi',
    model: 'A4',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/35/Audi_A4_B9_sedans_%28FL%29_1X7A2441.jpg/500px-Audi_A4_B9_sedans_%28FL%29_1X7A2441.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2008,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '2 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 76,
    source: 'postgres-seed',
  },
  {
    vin: '5HCACV81MDZ23G0R2',
    make: 'BMW',
    model: 'X5',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/f/f1/2019_BMW_X5_M50d_Automatic_3.0.jpg/500px-2019_BMW_X5_M50d_Automatic_3.0.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2020,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '1 reported incident',
    mileage: 'Mileage appears consistent',
    score: 77,
    source: 'postgres-seed',
  },
  {
    vin: 'LUS1X7JG2LFBDFHBY',
    make: 'Volvo',
    model: 'XC60',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/1a/2018_Volvo_XC60_R-Design_D5_P-Pulse_2.0_Front.jpg/500px-2018_Volvo_XC60_R-Design_D5_P-Pulse_2.0_Front.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2017,
    status: 'Verified',
    theft: 'No record',
    ownership: '4 owners',
    accidents: '3 reported incidents',
    mileage: 'Mileage varies from records',
    score: 79,
    source: 'postgres-seed',
  },
  {
    vin: '2SXHPCKP8TMDFLDW8',
    make: 'Ford',
    model: 'Ranger',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/28/Ford_Ranger_%28T6%2C_P703%29_Wildtrak_IMG_7320.jpg/500px-Ford_Ranger_%28T6%2C_P703%29_Wildtrak_IMG_7320.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2017,
    status: 'Needs review',
    theft: '1 stolen report',
    ownership: '2 owners',
    accidents: '2 reported incidents',
    mileage: 'Mileage varies from records',
    score: 72,
    source: 'postgres-seed',
  },
  {
    vin: 'FNTBSUCM7DEF97MU2',
    make: 'Volkswagen',
    model: 'Tiguan',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/ef/Volkswagen_Tiguan_III_IMG_8823_%28cropped%29.jpg/500px-Volkswagen_Tiguan_III_IMG_8823_%28cropped%29.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2012,
    status: 'Verified',
    theft: 'No record',
    ownership: 'Single owner',
    accidents: '1 reported incident',
    mileage: 'Mileage appears consistent',
    score: 76,
    source: 'postgres-seed',
  },
  {
    vin: 'RFFUC58T64MMYSVM3',
    make: 'Suzuki',
    model: 'Swift',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/3d/Suzuki_Swift_%282024%29_hybrid_DSC_6076.jpg/500px-Suzuki_Swift_%282024%29_hybrid_DSC_6076.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2021,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: 'No major accidents',
    mileage: 'Mileage appears consistent',
    score: 84,
    source: 'postgres-seed',
  },
  {
    vin: '84CVVC6A1Y46K8MGG',
    make: 'Volvo',
    model: 'XC60',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/1a/2018_Volvo_XC60_R-Design_D5_P-Pulse_2.0_Front.jpg/500px-2018_Volvo_XC60_R-Design_D5_P-Pulse_2.0_Front.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2007,
    status: 'Verified',
    theft: 'No record',
    ownership: '2 owners',
    accidents: '3 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 87,
    source: 'postgres-seed',
  },
  {
    vin: '2B1PBYBW5U6LBNPSK',
    make: 'Nissan',
    model: 'Note',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/41/2020-2024_Nissan_Note_S.jpg/500px-2020-2024_Nissan_Note_S.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2014,
    status: 'Verified',
    theft: 'No record',
    ownership: '3 owners',
    accidents: '1 reported incident',
    mileage: 'Mileage appears consistent',
    score: 83,
    source: 'postgres-seed',
  },
  {
    vin: 'G95RLFCYZ32F0T86H',
    make: 'Subaru',
    model: 'Forester',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/48/Subaru_Forester_%28SL%29_e-BOXER_DSC_8811.jpg/500px-Subaru_Forester_%28SL%29_e-BOXER_DSC_8811.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2013,
    status: 'Verified',
    theft: 'No record',
    ownership: '3 owners',
    accidents: 'No major accidents',
    mileage: 'Mileage appears consistent',
    score: 80,
    source: 'postgres-seed',
  },
  {
    vin: 'JRRB6WPPT8PC82MLJ',
    make: 'Ford',
    model: 'Focus',
    photo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/7/75/2018_Ford_Focus_ST-Line_X_1.0.jpg/500px-2018_Ford_Focus_ST-Line_X_1.0.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail',
    year: 2017,
    status: 'Verified',
    theft: 'No record',
    ownership: '3 owners',
    accidents: '0 reported incidents',
    mileage: 'Mileage appears consistent',
    score: 87,
    source: 'postgres-seed',
  },
];

const initializeDatabase = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vehicles (
      id SERIAL PRIMARY KEY,
      vin VARCHAR(30) UNIQUE NOT NULL,
      make VARCHAR(100) NOT NULL,
      model VARCHAR(100) NOT NULL,
      year INTEGER,
      status VARCHAR(50) NOT NULL,
      theft VARCHAR(150) NOT NULL,
      ownership VARCHAR(150) NOT NULL,
      accidents VARCHAR(150) NOT NULL,
      mileage VARCHAR(150) NOT NULL,
      score INTEGER,
      source VARCHAR(100) NOT NULL DEFAULT 'postgres',
      manufacturer VARCHAR(150),
      plant_country VARCHAR(100),
      body_class VARCHAR(100),
      vehicle_type VARCHAR(100),
      fuel_type VARCHAR(100),
      engine_cylinders VARCHAR(20),
      displacement_l VARCHAR(20),
      history_available BOOLEAN NOT NULL DEFAULT true,
      photo TEXT
    );
  `);

  // Relax/extend constraints for tables created before real-VIN (NHTSA) support was added.
  await pool.query('ALTER TABLE vehicles ALTER COLUMN year DROP NOT NULL;');
  await pool.query('ALTER TABLE vehicles ALTER COLUMN score DROP NOT NULL;');
  await pool.query('ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS manufacturer VARCHAR(150);');
  await pool.query('ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS plant_country VARCHAR(100);');
  await pool.query('ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS body_class VARCHAR(100);');
  await pool.query('ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS vehicle_type VARCHAR(100);');
  await pool.query('ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS fuel_type VARCHAR(100);');
  await pool.query('ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS engine_cylinders VARCHAR(20);');
  await pool.query('ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS displacement_l VARCHAR(20);');
  await pool.query("ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS history_available BOOLEAN NOT NULL DEFAULT true;");
  await pool.query('ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS photo TEXT;');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      name VARCHAR(150) NOT NULL,
      is_verified BOOLEAN NOT NULL DEFAULT false,
      verification_method VARCHAR(20) NOT NULL DEFAULT 'email',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS is_verified BOOLEAN NOT NULL DEFAULT false;');
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_method VARCHAR(20) NOT NULL DEFAULT 'email';");
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(20);');
  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS users_phone_unique ON users (phone) WHERE phone IS NOT NULL;');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS saved_reports (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      vin VARCHAR(30) NOT NULL,
      make VARCHAR(100),
      model VARCHAR(100),
      year INTEGER,
      status VARCHAR(50),
      theft VARCHAR(150),
      ownership VARCHAR(150),
      accidents VARCHAR(150),
      mileage VARCHAR(150),
      score INTEGER,
      saved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      selected_for_comparison BOOLEAN NOT NULL DEFAULT false,
      UNIQUE (user_id, vin)
    );
  `);

  await pool.query('ALTER TABLE saved_reports ADD COLUMN IF NOT EXISTS selected_for_comparison BOOLEAN NOT NULL DEFAULT false;');
  await pool.query('ALTER TABLE saved_reports ADD COLUMN IF NOT EXISTS photo TEXT;');


  await pool.query(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      plan VARCHAR(50) NOT NULL,
      amount INTEGER NOT NULL,
      phone VARCHAR(20) NOT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'pending',
      checkout_request_id VARCHAR(100) UNIQUE,
      mpesa_receipt VARCHAR(100),
      result_desc VARCHAR(255),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Stored in Postgres (not an in-memory Map) so pending codes survive a
  // redeploy or instance restart between /api/auth/otp/send and the follow-up
  // verification request.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS otp_codes (
      phone VARCHAR(20) PRIMARY KEY,
      code_hash VARCHAR(64) NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0
    );
  `);

  for (const vehicle of seedVehicles) {
    await pool.query(
      `
        INSERT INTO vehicles (vin, make, model, year, status, theft, ownership, accidents, mileage, score, source, photo)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        ON CONFLICT (vin) DO UPDATE SET photo = EXCLUDED.photo
      `,
      [vehicle.vin, vehicle.make, vehicle.model, vehicle.year, vehicle.status, vehicle.theft, vehicle.ownership, vehicle.accidents, vehicle.mileage, vehicle.score, vehicle.source, vehicle.photo || null]
    );
  }
};

app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, service: 'vinscope-vehicle-api', database: 'postgres' });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get('/api/admin/health/mpesa', requireAuth, (_req, res) => {
  const status = getMpesaConfigStatus();
  const callbackUrl = `${process.env.PUBLIC_BASE_URL || 'http://localhost:5000'}/api/payments/mpesa/callback`;

  res.json({
    ok: true,
    configured: status.configured,
    partiallyConfigured: status.partiallyConfigured,
    missing: status.missing,
    environment: status.environment,
    callbackUrl,
    mode: status.configured ? 'live' : 'demo-fallback',
  });
});

const VEHICLE_COLUMNS = `
  vin, make, model, year, status, theft, ownership, accidents, mileage, score, source,
  manufacturer, plant_country AS "plantCountry", body_class AS "bodyClass",
  vehicle_type AS "vehicleType", fuel_type AS "fuelType", engine_cylinders AS "engineCylinders",
  displacement_l AS "displacementL", history_available AS "historyAvailable", photo
`;

async function upsertVehicle(vehicle) {
  const {
    vin, make, model, year, status, theft, ownership, accidents, mileage, score, source,
    manufacturer = null, plantCountry = null, bodyClass = null, vehicleType = null,
    fuelType = null, engineCylinders = null, displacementL = null, historyAvailable = true,
    photo = null,
  } = vehicle;

  const { rows } = await pool.query(
    `
      INSERT INTO vehicles (
        vin, make, model, year, status, theft, ownership, accidents, mileage, score, source,
        manufacturer, plant_country, body_class, vehicle_type, fuel_type, engine_cylinders, displacement_l, history_available, photo
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
      ON CONFLICT (vin) DO UPDATE SET
        make = EXCLUDED.make,
        model = EXCLUDED.model,
        year = EXCLUDED.year,
        status = EXCLUDED.status,
        theft = EXCLUDED.theft,
        ownership = EXCLUDED.ownership,
        accidents = EXCLUDED.accidents,
        mileage = EXCLUDED.mileage,
        score = EXCLUDED.score,
        source = EXCLUDED.source,
        manufacturer = EXCLUDED.manufacturer,
        plant_country = EXCLUDED.plant_country,
        body_class = EXCLUDED.body_class,
        vehicle_type = EXCLUDED.vehicle_type,
        fuel_type = EXCLUDED.fuel_type,
        engine_cylinders = EXCLUDED.engine_cylinders,
        displacement_l = EXCLUDED.displacement_l,
        history_available = EXCLUDED.history_available,
        photo = EXCLUDED.photo
      RETURNING ${VEHICLE_COLUMNS}
    `,
    [
      vin, make, model, year, status, theft, ownership, accidents, mileage, score, source,
      manufacturer, plantCountry, bodyClass, vehicleType, fuelType, engineCylinders, displacementL, historyAvailable,
      photo,
    ]
  );

  return rows[0];
}

app.get('/api/vehicles/:vin', async (req, res) => {
  const vin = req.params.vin.trim().toUpperCase();

  if (!isValidVinFormat(vin)) {
    return res.status(400).json({
      error: `Invalid VIN format. A VIN is 17 characters (letters and numbers, excluding I, O, Q). You entered ${vin.length} character${vin.length === 1 ? '' : 's'}.`,
      vin,
    });
  }

  const { rows } = await pool.query(`SELECT ${VEHICLE_COLUMNS} FROM vehicles WHERE vin = $1`, [vin]);

  if (rows[0]) {
    return res.json(rows[0]);
  }

  // Not in our database - fall back to the free, public NHTSA vPIC decoder for a real VIN decode.
  // This works for VINs from any country (Kenya, Japan, etc.) since VIN structure is a global
  // ISO 3779 standard, but it cannot provide accident/theft/ownership history (no such free
  // public source exists), which is reflected via historyAvailable: false.
  const decoded = await decodeVinWithNhtsa(vin);
  if (!decoded) {
    return res.status(404).json({ error: 'Vehicle not found', vin });
  }

  const mapped = mapNhtsaResultToVehicle(vin, decoded);
  const cached = await upsertVehicle(mapped);
  return res.json(cached);
});

// Requires an authenticated user so only logged-in users can create/overwrite vehicle records.
app.post('/api/vehicles', requireAuth, async (req, res) => {
  const vehicle = req.body;
  if (!vehicle?.vin) {
    return res.status(400).json({ error: 'VIN is required' });
  }

  const saved = await upsertVehicle({
    ...vehicle,
    vin: vehicle.vin.toUpperCase(),
    source: vehicle.source || 'postgres',
  });

  return res.status(201).json(saved);
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

// Sends a 6-digit SMS code to a phone number, for either 'register' (new signup)
// or 'login' (existing account) purposes. In demo mode (no SMS provider configured)
// the code is echoed back in the response outside of production so the flow can
// still be tested end to end.
app.post('/api/auth/otp/send', otpLimiter, async (req, res) => {
  const { phone, purpose } = req.body || {};

  const issued = await issueOtp(pool, phone);
  if (!issued) {
    return res.status(400).json({ error: 'Enter a valid Kenyan phone number (e.g. 0712345678).' });
  }

  try {
    if (purpose === 'login') {
      const { rows } = await pool.query('SELECT id FROM users WHERE phone = $1', [issued.normalized]);
      if (!rows.length) {
        return res.status(404).json({ error: 'No account found with that phone number.' });
      }
    } else {
      const { rows } = await pool.query('SELECT id FROM users WHERE phone = $1', [issued.normalized]);
      if (rows.length) {
        return res.status(409).json({ error: 'An account with that phone number already exists.' });
      }
    }
  } catch (error) {
    console.error('OTP lookup failed', error);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }

  const demoModeAllowed = process.env.NODE_ENV !== 'production' || process.env.OTP_DEMO_MODE === 'true';
  try {
    await sendSms(issued.normalized, `Your Vinscope Kenya verification code is ${issued.code}. It expires in 5 minutes.`);
  } catch (error) {
    console.error('SMS send failed', error);
    if (!demoModeAllowed) {
      return res.status(502).json({ error: 'Could not send the SMS right now. Please try again.' });
    }
    // Provider is configured but failing (e.g. bad credentials) - fall through to the demo code below.
  }

  const response = { success: true, expiresInSeconds: 300 };
  // Africa's Talking can report a synchronous "Success" that only means the message was
  // queued, not that it actually reached the handset - real delivery failures happen
  // asynchronously and aren't visible here. So whenever demo mode is allowed, always
  // include the code as a guaranteed fallback rather than trusting the SMS "succeeded".
  if (demoModeAllowed) {
    response.demoCode = issued.code;
  }

  return res.json(response);
});

// Verifies a phone + code pair and logs the matching account in - passwordless login via SMS.
app.post('/api/auth/otp/login', loginLimiter, async (req, res) => {
  const { phone, code } = req.body || {};

  const result = await verifyOtp(pool, phone, code);
  if (!result.success) {
    return res.status(400).json({ error: result.message });
  }

  try {
    const { rows } = await pool.query(
      'SELECT id, email, name, is_verified, verification_method FROM users WHERE phone = $1',
      [result.normalized]
    );
    const user = rows[0];
    if (!user) {
      return res.status(404).json({ error: 'No account found with that phone number.' });
    }

    setAuthCookie(res, signToken({ id: user.id, email: user.email }));
    return res.json({ user: { id: user.id, email: user.email, name: user.name, isVerified: user.is_verified, verificationMethod: user.verification_method } });
  } catch (error) {
    console.error('Phone login failed', error);
    return res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

app.post('/api/auth/register', registerLimiter, async (req, res) => {
  const { email, password, name, phone, code, verificationMethod } = req.body || {};

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }
  if (!EMAIL_REGEX.test(email)) {
    return res.status(400).json({ error: 'Enter a valid email address' });
  }
  if (String(password).length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  const normalizedEmail = email.trim().toLowerCase();
  const usingSms = verificationMethod === 'sms';
  let normalizedPhone = null;

  if (usingSms) {
    if (!phone || !code) {
      return res.status(400).json({ error: 'Enter the SMS code sent to your phone.' });
    }

    const otpResult = await verifyOtp(pool, phone, code);
    if (!otpResult.success) {
      return res.status(400).json({ error: otpResult.message });
    }

    normalizedPhone = otpResult.normalized;
  }

  try {
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [normalizedEmail]);
    if (existing.rows.length) {
      return res.status(409).json({ error: 'An account with that email already exists' });
    }

    if (normalizedPhone) {
      const existingPhone = await pool.query('SELECT id FROM users WHERE phone = $1', [normalizedPhone]);
      if (existingPhone.rows.length) {
        return res.status(409).json({ error: 'An account with that phone number already exists' });
      }
    }

    const passwordHash = await hashPassword(password);
    const { rows } = await pool.query(
      'INSERT INTO users (email, password_hash, name, phone, is_verified, verification_method) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, email, name, phone, is_verified, verification_method',
      [normalizedEmail, passwordHash, (name || '').trim() || 'Vinscope User', normalizedPhone, true, usingSms ? 'sms' : 'email']
    );

    const user = rows[0];
    setAuthCookie(res, signToken({ id: user.id, email: user.email }));
    return res.status(201).json({ user: { id: user.id, email: user.email, name: user.name, phone: user.phone, isVerified: user.is_verified, verificationMethod: user.verification_method } });
  } catch (error) {
    console.error('Registration failed', error);
    return res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
});

app.post('/api/auth/login', loginLimiter, async (req, res) => {
  const { email, password } = req.body || {};

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const normalizedEmail = email.trim().toLowerCase();

  try {
    const { rows } = await pool.query(
      'SELECT id, email, name, password_hash, is_verified, verification_method FROM users WHERE email = $1',
      [normalizedEmail]
    );
    const user = rows[0];
    const valid = user && (await verifyPassword(password, user.password_hash));

    if (!valid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    setAuthCookie(res, signToken({ id: user.id, email: user.email }));
    return res.json({ user: { id: user.id, email: user.email, name: user.name, isVerified: user.is_verified, verificationMethod: user.verification_method } });
  } catch (error) {
    console.error('Login failed', error);
    return res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

app.post('/api/auth/logout', (_req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

app.get('/api/auth/me', requireAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT id, email, name, is_verified, verification_method FROM users WHERE id = $1', [req.user.id]);
  if (!rows[0]) {
    return res.status(404).json({ error: 'User not found' });
  }
  res.json({ user: rows[0] });
});

// ---------------------------------------------------------------------------
// Saved reports (per authenticated user)
// ---------------------------------------------------------------------------

const REPORT_COLUMNS = `vin, make, model, year, status, theft, ownership, accidents, mileage, score, photo, saved_at AS "savedAt", selected_for_comparison AS "selectedForComparison"`;

app.get('/api/reports', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT ${REPORT_COLUMNS} FROM saved_reports WHERE user_id = $1 ORDER BY saved_at DESC`,
    [req.user.id]
  );
  res.json(rows);
});

app.post('/api/reports', requireAuth, async (req, res) => {
  const report = req.body || {};
  if (!report.vin) {
    return res.status(400).json({ error: 'VIN is required' });
  }

  const { rows } = await pool.query(
    `
      INSERT INTO saved_reports (user_id, vin, make, model, year, status, theft, ownership, accidents, mileage, score, photo)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT (user_id, vin) DO UPDATE SET
        make = EXCLUDED.make, model = EXCLUDED.model, year = EXCLUDED.year, status = EXCLUDED.status,
        theft = EXCLUDED.theft, ownership = EXCLUDED.ownership, accidents = EXCLUDED.accidents,
        mileage = EXCLUDED.mileage, score = EXCLUDED.score, photo = EXCLUDED.photo, saved_at = now()
      RETURNING ${REPORT_COLUMNS}
    `,
    [
      req.user.id,
      String(report.vin).toUpperCase(),
      report.make || null,
      report.model || null,
      report.year || null,
      report.status || null,
      report.theft || null,
      report.ownership || null,
      report.accidents || null,
      report.mileage || null,
      report.score ?? null,
      report.photo || null,
    ]
  );

  res.status(201).json(rows[0]);
});

app.delete('/api/reports/:vin', requireAuth, async (req, res) => {
  await pool.query('DELETE FROM saved_reports WHERE user_id = $1 AND vin = $2', [
    req.user.id,
    req.params.vin.toUpperCase(),
  ]);
  res.json({ ok: true });
});

app.patch('/api/reports/:vin/comparison', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE saved_reports SET selected_for_comparison = $1 WHERE user_id = $2 AND vin = $3 RETURNING ${REPORT_COLUMNS}`,
    [Boolean(req.body?.selected), req.user.id, req.params.vin.toUpperCase()]
  );

  if (!rows[0]) {
    return res.status(404).json({ error: 'Saved report not found' });
  }

  res.json(rows[0]);
});

// ---------------------------------------------------------------------------
// M-Pesa payments (Daraja STK Push)
// ---------------------------------------------------------------------------

const PLAN_AMOUNTS = { Starter: 0, Pro: 1500, Business: 2999 };

app.post('/api/payments/stkpush', requireAuth, async (req, res) => {
  const { plan, phone } = req.body || {};
  const amount = PLAN_AMOUNTS[plan];

  if (!amount) {
    return res.status(400).json({ error: 'Choose a valid plan (Pro or Business)' });
  }

  const normalizedPhone = normalizeKenyanPhone(phone);
  if (!normalizedPhone) {
    return res.status(400).json({ error: 'Enter a valid Safaricom number, e.g. 07XXXXXXXX' });
  }

  const publicBaseUrl = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;

  try {
    const stk = await initiateStkPush({
      phone: normalizedPhone,
      amount,
      plan,
      callbackUrl: `${publicBaseUrl}/api/payments/mpesa/callback`,
    });

    await pool.query(
      `INSERT INTO subscriptions (user_id, plan, amount, phone, status, checkout_request_id)
       VALUES ($1, $2, $3, $4, 'pending', $5)
       ON CONFLICT (checkout_request_id) DO NOTHING`,
      [req.user.id, plan, amount, normalizedPhone, stk.CheckoutRequestID]
    );

    return res.status(202).json({
      checkoutRequestId: stk.CheckoutRequestID,
      message: stk.CustomerMessage || 'Enter your M-Pesa PIN on your phone to complete payment.',
    });
  } catch (error) {
    const diagnostics = error.mpesaDiagnostics || null;
    console.error('STK push failed', diagnostics || error);
    return res.status(502).json({
      error: error.message || 'Could not start M-Pesa payment',
      diagnostics,
      hint: 'Verify Daraja credentials, shortcode/passkey, callback URL, and Safaricom number format.',
    });
  }
});

// Public endpoint - called by Safaricom's servers, not the browser.
app.post('/api/payments/mpesa/callback', async (req, res) => {
  const result = parseStkCallback(req.body);

  if (result) {
    await pool.query(
      `UPDATE subscriptions
       SET status = $1, mpesa_receipt = $2, result_desc = $3, updated_at = now()
       WHERE checkout_request_id = $4`,
      [result.success ? 'completed' : 'failed', result.mpesaReceipt, result.resultDesc, result.checkoutRequestId]
    );
  }

  // Safaricom expects a 200 response acknowledging receipt of the callback.
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
});

app.get('/api/payments/status/:checkoutRequestId', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT status, plan, mpesa_receipt AS "mpesaReceipt" FROM subscriptions WHERE checkout_request_id = $1 AND user_id = $2',
    [req.params.checkoutRequestId, req.user.id]
  );

  if (!rows[0]) {
    return res.status(404).json({ error: 'Payment not found' });
  }

  res.json(rows[0]);
});

app.get(/^(?!\/api|\/health).*/, (_req, res) => {
  res.sendFile(path.join(distDir, 'index.html'));
});

const port = process.env.PORT || 5000;
if (process.env.NODE_ENV !== 'test') {
  initializeDatabase()
    .then(() => {
      app.listen(port, () => {
        console.log(`Vehicle API listening on port ${port}`);
      });
    })
    .catch((error) => {
      console.error('Database initialization failed', error);
      process.exit(1);
    });
}

export { app, pool, initializeDatabase };
