import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Initialize Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ============================================
// SEARCH ENDPOINTS
// ============================================

// Search services by keyword + filters
app.get('/api/search/services', async (req, res) => {
  try {
    const { 
      q,           // search query
      district,    // filter by district
      city,        // filter by city
      provider_id, // filter by provider
      min_price,
      max_price,
      service_type
    } = req.query;
console.log('Search query received:', q); // ADD THIS
    console.log('Query params:', req.query); // ADD THIS
    let query = supabase
      .from('provider_services')
      .select(`
        *,
        providers:provider_id (
          id,
          brand_name_vn,
          logo_url
        )
      `)
      .eq('status', 'active')
      .is('deleted_at', null);

// Text search - split query into words and match all
    if (q) {
    const searchWords = q.toLowerCase().split(/\s+/).filter(w => w.length > 0);
    console.log('Search query:', q); // ADD THIS
    console.log('Search words:', searchWords); // ADD THIS
    searchWords.forEach(word => {
        query = query.ilike('keywords', `%${word}%`);
    });
    }

    // Provider filter
    if (provider_id) {
      query = query.eq('provider_id', provider_id);
    }

    // Service type filter
    if (service_type) {
      query = query.eq('service_type', service_type);
    }

    // Price filters
    if (min_price) {
      query = query.gte('discounted_price', min_price);
    }
    if (max_price) {
      query = query.lte('discounted_price', max_price);
    }

    const { data: services, error } = await query
    //   .order('discounted_price', { ascending: true })
    //   .limit(50);

    if (error) throw error;
    console.log('Results count:', services?.length); // ADD THIS
    console.log('Package 56 in results?', services?.some(s => s.id === 56)); // ADD THIS

    // If district/city filter, get branches
    let filteredServices = services;
    
    if (district || city) {
      const serviceIds = services.map(s => s.id);
      
      const { data: branchServices } = await supabase
        .from('branch_services')
        .select(`
          provider_service_id,
          branches!inner (
            district,
            city
          )
        `)
        .in('provider_service_id', serviceIds)
        .eq('is_available', true);

      // Filter services that have branches in requested location
      const availableServiceIds = new Set();
      branchServices?.forEach(bs => {
        const matchDistrict = !district || bs.branches.district === district;
        const matchCity = !city || bs.branches.city === city;
        if (matchDistrict && matchCity) {
          availableServiceIds.add(bs.provider_service_id);
        }
      });

      filteredServices = services.filter(s => availableServiceIds.has(s.id));
    }

    res.json({
      success: true,
      data: filteredServices,
      total: filteredServices.length
    });

  } catch (error) {
    console.error('Search services error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Search branches offering a specific service
app.get('/api/search/branches', async (req, res) => {
  try {
    const { service_id, district, city } = req.query;

    if (!service_id) {
      return res.status(400).json({
        success: false,
        error: 'service_id is required'
      });
    }

    let query = supabase
      .from('branch_services')
      .select(`
        *,
        branches!inner (
          *,
          providers (
            brand_name_vn,
            logo_url
          )
        )
      `)
      .eq('provider_service_id', service_id)
      .eq('is_available', true)
      .eq('branches.status', 'active')
      .is('branches.deleted_at', null);

    if (district) {
      query = query.eq('branches.district', district);
    }
    if (city) {
      query = query.eq('branches.city', city);
    }

    const { data, error } = await query;

    if (error) throw error;

    const branches = data.map(bs => ({
      ...bs.branches,
      service_price: bs.branch_price || null
    }));

    res.json({
      success: true,
      data: branches,
      total: branches.length
    });

  } catch (error) {
    console.error('Search branches error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// List all providers
app.get('/api/providers', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('providers')
      .select('*')
      .eq('partnership_status', 'active')
      .is('deleted_at', null)
      .order('brand_name_vn');

    if (error) throw error;

    res.json({
      success: true,
      data,
      total: data.length
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============================================
// SERVICE DETAIL ENDPOINTS
// ============================================

// Get service details
app.get('/api/services/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Get service details
    const { data: service, error: serviceError } = await supabase
      .from('provider_services')
      .select(`
        *,
        providers (
          brand_name_vn,
          logo_url,
          phone,
          email
        )
      `)
      .eq('id', id)
      .single();

    if (serviceError) throw serviceError;

    // Get available branches count
    const { count: branchCount } = await supabase
      .from('branch_services')
      .select('*', { count: 'exact', head: true })
      .eq('provider_service_id', id)
      .eq('is_available', true);

    // Get package components if it's a package (SIMPLIFIED QUERY)
    let components = [];
    if (service.service_type === 'package') {
      // Get component IDs first
      const { data: componentLinks } = await supabase
        .from('package_components')
        .select('component_service_id, display_order')
        .eq('package_service_id', id)
        .order('display_order');

      if (componentLinks && componentLinks.length > 0) {
        const componentIds = componentLinks.map(c => c.component_service_id);

        // Get test details
        const { data: tests } = await supabase
          .from('provider_services')
          .select('id, provider_service_name_vn, discounted_price, canonical_service_id')
          .in('id', componentIds);

        // Get canonical test names
        const canonicalIds = tests
          .map(t => t.canonical_service_id)
          .filter(Boolean);

        let canonicalTests = {};
        if (canonicalIds.length > 0) {
          const { data: canonicalData } = await supabase
            .from('provider_services')
            .select('id, provider_service_name_vn, discounted_price')
            .in('id', canonicalIds);

          canonicalData?.forEach(test => {
            canonicalTests[test.id] = test;
          });
        }

        // Map to component structure
        components = tests.map(test => {
          const canonicalTest = canonicalTests[test.canonical_service_id];
          return {
            component: {
              id: test.id,
              provider_service_name_vn: test.provider_service_name_vn,
              discounted_price: test.discounted_price,
              display_name: canonicalTest?.provider_service_name_vn || test.provider_service_name_vn,
              display_price: canonicalTest?.discounted_price || test.discounted_price
            }
          };
        });
      }
    }

    res.json({
      success: true,
      data: {
        ...service,
        branches_available: branchCount || 0,
        components
      }
    });

  } catch (error) {
    console.error('Service detail error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get branches offering this service
app.get('/api/services/:id/branches', async (req, res) => {
  try {
    const { id } = req.params;
    const { district, city } = req.query;

    let query = supabase
      .from('branch_services')
      .select(`
        *,
        branches!inner (
          *,
          providers (brand_name_vn)
        )
      `)
      .eq('provider_service_id', id)
      .eq('is_available', true);

    if (district) {
      query = query.eq('branches.district', district);
    }
    if (city) {
      query = query.eq('branches.city', city);
    }

    const { data, error } = await query;

    if (error) throw error;

    res.json({
      success: true,
      data: data.map(bs => ({
        ...bs.branches,
        service_price: bs.branch_price
      })),
      total: data.length
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get branch details
app.get('/api/branches/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: branch, error } = await supabase
      .from('branches')
      .select(`
        *,
        providers (
          brand_name_vn,
          logo_url,
          phone,
          email
        )
      `)
      .eq('id', id)
      .single();

    if (error) throw error;

    // Get available services at this branch
    const { data: services } = await supabase
      .from('branch_services')
      .select(`
        *,
        provider_services!inner (
          id,
          provider_service_name_vn,
          service_type,
          discounted_price,
          short_description
        )
      `)
      .eq('branch_id', id)
      .eq('is_available', true)
      .eq('provider_services.status', 'active');

    res.json({
      success: true,
      data: {
        ...branch,
        services: services?.map(s => ({
          ...s.provider_services,
          branch_price: s.branch_price
        })) || []
      }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============================================
// BOOKING ENDPOINTS
// ============================================

// Create booking
app.post('/api/bookings', async (req, res) => {
  try {
    const {
      provider_service_id,
      branch_id,
      patient_name,
      patient_phone,
      patient_email,
      patient_gender,
      patient_birth_year,
      appointment_date,
      appointment_time_slot,
      service_mode,
      promo_code,
      patient_notes,
      created_by_email
    } = req.body;

    // Validate required fields
    if (!provider_service_id || !branch_id || !patient_name || !patient_phone || !appointment_date) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields'
      });
    }

    // Get service details for pricing
    const { data: service } = await supabase
      .from('provider_services')
      .select('*, providers(*)')
      .eq('id', provider_service_id)
      .single();

    if (!service) {
      return res.status(404).json({
        success: false,
        error: 'Service not found'
      });
    }

    const listed_price = service.discounted_price || service.original_price;
    let discount_amount = 0;

    // Apply promo code if provided
    if (promo_code) {
      const { data: promo } = await supabase
        .from('promotions')
        .select('*')
        .eq('promo_code', promo_code)
        .eq('is_active', true)
        .single();

      if (promo && new Date() >= new Date(promo.valid_from) && new Date() <= new Date(promo.valid_to)) {
        if (promo.discount_type === 'percentage') {
          discount_amount = listed_price * (promo.discount_value / 100);
        } else {
          discount_amount = promo.discount_value;
        }
        
        if (promo.max_discount_amount && discount_amount > promo.max_discount_amount) {
          discount_amount = promo.max_discount_amount;
        }
      }
    }

    const final_price = listed_price - discount_amount;

    // Calculate commission
    const commission_rate = service.commission_rate || service.providers.base_commission_rate;
    const commission_amount = final_price * commission_rate;

    // Generate booking reference
    const providerCode = service.providers.provider_code.split('_')[1] || 'XXX';
    const count = await supabase
      .from('bookings')
      .select('id', { count: 'exact', head: true });
    
    const bookingNumber = String((count.count || 0) + 1).padStart(5, '0');
    const booking_reference = `HH-${providerCode}${bookingNumber}`;

    // Create booking
    const { data: booking, error } = await supabase
      .from('bookings')
      .insert({
        booking_reference,
        provider_id: service.provider_id,
        branch_id,
        provider_service_id,
        patient_name,
        patient_phone,
        patient_email,
        patient_gender,
        patient_birth_year,
        appointment_date,
        appointment_time_slot: appointment_time_slot || 'morning',
        service_mode: service_mode || 'in_clinic',
        listed_price,
        promo_code,
        discount_amount,
        final_price,
        applicable_commission_rate: commission_rate,
        commission_amount,
        status: 'confirmed',
        payment_status: 'pending',
        patient_notes,
        created_by_email
      })
      .select()
      .single();

    if (error) throw error;

    res.json({
      success: true,
      data: booking,
      message: 'Booking created successfully'
    });

  } catch (error) {
    console.error('Create booking error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get booking by reference
app.get('/api/bookings/:reference', async (req, res) => {
  try {
    const { reference } = req.params;

    const { data: booking, error } = await supabase
      .from('bookings')
      .select(`
        *,
        providers (brand_name_vn, logo_url),
        branches (branch_name_vn, address, phone),
        provider_services (provider_service_name_vn, service_type)
      `)
      .eq('booking_reference', reference)
      .single();

    if (error) throw error;

    res.json({
      success: true,
      data: booking
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============================================
// REPORTS ENDPOINTS
// ============================================

// Booking summary report
app.get('/api/reports/bookings', async (req, res) => {
  try {
    const { provider_id, month, status } = req.query;

    let query = supabase
      .from('bookings')
      .select('*');

    if (provider_id) {
      query = query.eq('provider_id', provider_id);
    }

    if (month) {
      const startDate = new Date(month + '-01');
      const endDate = new Date(startDate);
      endDate.setMonth(endDate.getMonth() + 1);
      
      query = query
        .gte('created_at', startDate.toISOString())
        .lt('created_at', endDate.toISOString());
    }

    if (status) {
      query = query.eq('status', status);
    }

    const { data: bookings, error } = await query;

    if (error) throw error;

    // Calculate summary
    const summary = {
      total: bookings.length,
      confirmed: bookings.filter(b => b.status === 'confirmed').length,
      completed: bookings.filter(b => b.status === 'completed').length,
      cancelled: bookings.filter(b => b.status === 'cancelled').length,
      no_show: bookings.filter(b => b.status === 'no_show').length,
      total_revenue: bookings.reduce((sum, b) => sum + (b.final_price || 0), 0),
      total_commission: bookings.reduce((sum, b) => sum + (b.commission_amount || 0), 0)
    };

    res.json({
      success: true,
      summary,
      data: bookings
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Start server
app.listen(PORT, () => {
  console.log(`\n✅ API Server running on http://localhost:${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/health\n`);
});