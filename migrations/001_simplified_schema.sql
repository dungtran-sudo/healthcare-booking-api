-- ============================================
-- SIMPLIFIED SCHEMA MIGRATION
-- ============================================
-- This migration creates the new simplified schema
-- while preserving old tables for safety

-- ============================================
-- 1. CREATE NEW TABLES
-- ============================================

-- Facilities table (replaces branches)
CREATE TABLE IF NOT EXISTS facilities (
    id SERIAL PRIMARY KEY,
    provider_id INTEGER NOT NULL REFERENCES providers(id),
    name VARCHAR(255) NOT NULL,
    address TEXT,
    district VARCHAR(100),
    city VARCHAR(100),
    working_hours TEXT,
    phone VARCHAR(50),
    email VARCHAR(255),
    lat DECIMAL(10, 8),
    lng DECIMAL(11, 8),
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Catalog items (the core flattened SKU table)
CREATE TABLE IF NOT EXISTS catalog_items (
    id SERIAL PRIMARY KEY,
    facility_id INTEGER NOT NULL REFERENCES facilities(id),
    item_type VARCHAR(20) NOT NULL CHECK (item_type IN ('SERVICE', 'PACKAGE')),

    name VARCHAR(500) NOT NULL,
    description TEXT,
    price DECIMAL(12, 2),

    keywords TEXT,  -- For search optimization
    is_active BOOLEAN DEFAULT TRUE,
    display_order INTEGER DEFAULT 0,

    -- Reference to old system (for migration tracking)
    legacy_provider_service_id INTEGER,

    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Package components (what's inside a package)
CREATE TABLE IF NOT EXISTS package_components (
    id SERIAL PRIMARY KEY,
    catalog_item_id INTEGER NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE,
    component_name VARCHAR(500) NOT NULL,
    component_description TEXT,
    display_order INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Simplified bookings table
CREATE TABLE IF NOT EXISTS bookings_v2 (
    id SERIAL PRIMARY KEY,
    facility_id INTEGER NOT NULL REFERENCES facilities(id),
    booking_type VARCHAR(20) NOT NULL CHECK (booking_type IN ('PACKAGE', 'SERVICES')),

    customer_name VARCHAR(255) NOT NULL,
    customer_phone VARCHAR(50) NOT NULL,
    customer_email VARCHAR(255),

    appointment_date DATE NOT NULL,
    appointment_time_slot VARCHAR(50),
    notes TEXT,

    total_amount DECIMAL(12, 2),
    status VARCHAR(50) DEFAULT 'pending',
    booking_reference VARCHAR(50) UNIQUE,

    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Booking line items
CREATE TABLE IF NOT EXISTS booking_items (
    id SERIAL PRIMARY KEY,
    booking_id INTEGER NOT NULL REFERENCES bookings_v2(id) ON DELETE CASCADE,
    catalog_item_id INTEGER NOT NULL REFERENCES catalog_items(id),
    price_at_booking DECIMAL(12, 2) NOT NULL,
    quantity INTEGER DEFAULT 1,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================
-- 2. CREATE INDEXES
-- ============================================

CREATE INDEX IF NOT EXISTS idx_facilities_provider ON facilities(provider_id);
CREATE INDEX IF NOT EXISTS idx_facilities_city ON facilities(city);
CREATE INDEX IF NOT EXISTS idx_facilities_district ON facilities(district);
CREATE INDEX IF NOT EXISTS idx_facilities_active ON facilities(is_active);

CREATE INDEX IF NOT EXISTS idx_catalog_items_facility ON catalog_items(facility_id);
CREATE INDEX IF NOT EXISTS idx_catalog_items_type ON catalog_items(item_type);
CREATE INDEX IF NOT EXISTS idx_catalog_items_active ON catalog_items(is_active);
CREATE INDEX IF NOT EXISTS idx_catalog_items_name ON catalog_items(name);
CREATE INDEX IF NOT EXISTS idx_catalog_items_keywords ON catalog_items USING gin(to_tsvector('simple', keywords));

CREATE INDEX IF NOT EXISTS idx_package_components_catalog ON package_components(catalog_item_id);

CREATE INDEX IF NOT EXISTS idx_bookings_v2_facility ON bookings_v2(facility_id);
CREATE INDEX IF NOT EXISTS idx_bookings_v2_status ON bookings_v2(status);
CREATE INDEX IF NOT EXISTS idx_bookings_v2_date ON bookings_v2(appointment_date);

CREATE INDEX IF NOT EXISTS idx_booking_items_booking ON booking_items(booking_id);

-- ============================================
-- 3. ROW LEVEL SECURITY (RLS)
-- ============================================

ALTER TABLE facilities ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE package_components ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookings_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_items ENABLE ROW LEVEL SECURITY;

-- Allow read access to all for facilities and catalog
CREATE POLICY "Allow public read facilities" ON facilities FOR SELECT USING (true);
CREATE POLICY "Allow public read catalog_items" ON catalog_items FOR SELECT USING (true);
CREATE POLICY "Allow public read package_components" ON package_components FOR SELECT USING (true);

-- Allow all operations for authenticated/service role
CREATE POLICY "Allow service role all on facilities" ON facilities FOR ALL USING (true);
CREATE POLICY "Allow service role all on catalog_items" ON catalog_items FOR ALL USING (true);
CREATE POLICY "Allow service role all on package_components" ON package_components FOR ALL USING (true);
CREATE POLICY "Allow service role all on bookings_v2" ON bookings_v2 FOR ALL USING (true);
CREATE POLICY "Allow service role all on booking_items" ON booking_items FOR ALL USING (true);
