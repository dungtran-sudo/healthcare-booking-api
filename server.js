import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

function normalizeVi(str = '') {
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .trim()
    .replace(/\s+/g, ' ');
}

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

// Calculate relevance score for a service
function calculateRelevance(service, queryNorm, queryWords) {
  let score = 0;
  const name = normalizeVi(service.provider_service_name_vn || '');
  const keywords = (service.keywords || '').toLowerCase();
  const description = normalizeVi(service.short_description || '');

  // Exact name match: highest score
  if (name === queryNorm) {
    score += 1000;
  }
  // Name starts with query
  else if (name.startsWith(queryNorm)) {
    score += 500;
  }
  // Name contains full query
  else if (name.includes(queryNorm)) {
    score += 300;
  }

  // Word matching in name
  let nameWordMatches = 0;
  for (const word of queryWords) {
    if (name.includes(word)) {
      nameWordMatches++;
      score += 50;
    }
  }
  // Bonus for matching all words
  if (nameWordMatches === queryWords.length && queryWords.length > 1) {
    score += 100;
  }

  // Word matching in keywords
  for (const word of queryWords) {
    if (keywords.includes(word)) {
      score += 20;
    }
  }

  // Word matching in description
  for (const word of queryWords) {
    if (description.includes(word)) {
      score += 10;
    }
  }

  // Boost packages slightly (they're often more relevant)
  if (service.service_type === 'package') {
    score += 25;
  }

  // Boost services with tiered pricing (more complete data)
  if (service.pricing_data && service.pricing_data.length > 0) {
    score += 10;
  }

  return score;
}

// Search services by keyword + filters with relevance ranking
app.get('/api/search/services', async (req, res) => {
  try {
    const {
      q,
      district,
      city,
      provider_id,
      min_price,
      max_price,
      service_type,
      limit = 200
    } = req.query;

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
      .eq('is_bookable', true)
      .is('deleted_at', null);

    const queryNorm = q ? normalizeVi(q) : '';
    const queryWords = queryNorm.split(' ').filter(w => w.length >= 2);

    // Text search - use OR logic for broader results, then rank
    if (q && queryWords.length > 0) {
      // Search in both keywords and name for better coverage
      // Use .or() for flexible matching
      const searchConditions = queryWords.map(word =>
        `keywords.ilike.%${word}%,provider_service_name_vn.ilike.%${word}%`
      ).join(',');

      query = query.or(searchConditions);
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

    const { data: services, error } = await query.limit(500); // Get more, then rank

    if (error) throw error;

    // If district/city filter, get branches
    let filteredServices = services || [];

    if (district || city) {
      const serviceIds = filteredServices.map(s => s.id);

      if (serviceIds.length > 0) {
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

        const availableServiceIds = new Set();
        branchServices?.forEach(bs => {
          const matchDistrict = !district ||
            normalizeVi(bs.branches.district || '').includes(normalizeVi(district));
          const matchCity = !city ||
            normalizeVi(bs.branches.city || '').includes(normalizeVi(city));
          if (matchDistrict && matchCity) {
            availableServiceIds.add(bs.provider_service_id);
          }
        });

        filteredServices = filteredServices.filter(s => availableServiceIds.has(s.id));
      }
    }

    // Calculate relevance scores and sort
    if (q) {
      filteredServices = filteredServices.map(service => ({
        ...service,
        _relevance: calculateRelevance(service, queryNorm, queryWords)
      }));

      // Sort by relevance (highest first)
      filteredServices.sort((a, b) => b._relevance - a._relevance);

      // Remove zero-relevance results if we have enough good matches
      const goodMatches = filteredServices.filter(s => s._relevance > 0);
      if (goodMatches.length >= 10) {
        filteredServices = goodMatches;
      }
    }

    // Apply limit
    filteredServices = filteredServices.slice(0, parseInt(limit));

    res.json({
      success: true,
      data: filteredServices,
      total: filteredServices.length,
      query: q || null
    });

  } catch (error) {
    console.error('Search services error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Search suggestions (autocomplete)
app.get('/api/search/suggestions', async (req, res) => {
  try {
    const { q } = req.query;

    if (!q || q.length < 2) {
      return res.json({ success: true, data: [] });
    }

    const queryNorm = normalizeVi(q);

    // Get services that start with or contain the query
    const { data: services, error } = await supabase
      .from('provider_services')
      .select(`
        id,
        provider_service_name_vn,
        service_type,
        service_category,
        discounted_price,
        providers:provider_id (brand_name_vn)
      `)
      .eq('status', 'active')
      .eq('is_bookable', true)
      .is('deleted_at', null)
      .or(`provider_service_name_vn.ilike.${q}%,provider_service_name_vn.ilike.%${q}%,keywords.ilike.%${queryNorm}%`)
      .limit(15);

    if (error) throw error;

    // Deduplicate by name and sort by relevance
    const seen = new Set();
    const suggestions = [];

    for (const service of services || []) {
      const name = service.provider_service_name_vn;
      if (!seen.has(name)) {
        seen.add(name);
        suggestions.push({
          id: service.id,
          name: name,
          type: service.service_type,
          category: service.service_category,
          provider: service.providers?.brand_name_vn || null,
          price: service.discounted_price || null
        });
      }
    }

    // Sort: exact prefix matches first, then by type (packages first)
    suggestions.sort((a, b) => {
      const aStarts = normalizeVi(a.name).startsWith(queryNorm);
      const bStarts = normalizeVi(b.name).startsWith(queryNorm);
      if (aStarts && !bStarts) return -1;
      if (!aStarts && bStarts) return 1;
      // Packages first
      if (a.type === 'package' && b.type !== 'package') return -1;
      if (a.type !== 'package' && b.type === 'package') return 1;
      return a.name.length - b.name.length; // Shorter names first
    });

    res.json({
      success: true,
      data: suggestions.slice(0, 8)
    });

  } catch (error) {
    console.error('Search suggestions error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Popular services (for empty search state)
app.get('/api/search/popular', async (req, res) => {
  try {
    // Get popular packages (root-level packages are typically what users search for)
    const { data: packages, error: pkgError } = await supabase
      .from('provider_services')
      .select(`
        id,
        provider_service_name_vn,
        service_type,
        service_category,
        discounted_price,
        providers:provider_id (brand_name_vn)
      `)
      .eq('status', 'active')
      .eq('is_bookable', true)
      .eq('service_type', 'package')
      .is('parent_service_id', null)
      .is('deleted_at', null)
      .not('discounted_price', 'is', null)
      .order('discounted_price', { ascending: true })
      .limit(6);

    if (pkgError) throw pkgError;

    // If not enough packages, also get some atomic services
    let popularServices = packages || [];

    if (popularServices.length < 6) {
      const { data: atomics } = await supabase
        .from('provider_services')
        .select(`
          id,
          provider_service_name_vn,
          service_type,
          service_category,
          discounted_price,
          providers:provider_id (brand_name_vn)
        `)
        .eq('status', 'active')
        .eq('is_bookable', true)
        .eq('service_type', 'atomic')
        .is('deleted_at', null)
        .not('discounted_price', 'is', null)
        .limit(6 - popularServices.length);

      popularServices = [...popularServices, ...(atomics || [])];
    }

    res.json({
      success: true,
      data: popularServices
    });

  } catch (error) {
    console.error('Popular services error:', error);
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

// Get service details with children
app.get('/api/services/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: service, error: serviceError } = await supabase
      .from('provider_services')
      .select(`
        *,
        providers:provider_id (
          id,
          brand_name_vn,
          logo_url
        )
      `)
      .eq('id', id)
      .eq('status', 'active')
      .single();

    if (serviceError) throw serviceError;
    if (!service) {
      return res.status(404).json({ success: false, error: 'Service not found' });
    }

    const { data: children, error: childrenError } = await supabase
      .from('provider_services')
      .select(`
        id,
        provider_service_name_vn,
        short_description,
        discounted_price,
        original_price,
        service_type,
        service_category,
        is_bookable,
        display_order
      `)
      .eq('parent_service_id', id)
      .eq('status', 'active')
      .order('display_order')
      .order('id');

    if (childrenError) throw childrenError;

    const response = {
      ...service,
      components: (children || []).map(child => ({
        component: {
          ...child,
          display_name: child.provider_service_name_vn,
          display_price: child.discounted_price || child.original_price
        }
      }))
    };

    res.json({ success: true, data: response });

  } catch (error) {
    console.error('Error fetching service:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get immediate children only
app.get('/api/services/:id/children', async (req, res) => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from('provider_services')
      .select(`
        id,
        provider_service_name_vn,
        short_description,
        full_description,
        original_price,
        discounted_price,
        service_type,
        service_category,
        depth_level,
        is_bookable,
        suitable_for,
        key_benefits,
        target_age_group,
        display_order
      `)
      .eq('parent_service_id', id)
      .eq('status', 'active')
      .order('display_order')
      .order('id');

    if (error) throw error;

    res.json({ success: true, data: data || [] });

  } catch (error) {
    console.error('Error fetching children:', error);
    res.status(500).json({ success: false, error: error.message });
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
      created_by_email,
      cart_items
    } = req.body;

    if (!branch_id || !patient_name || !patient_phone || !appointment_date) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields'
      });
    }

    const isCustomBundle = cart_items && cart_items.length > 0;
    
    let service, listed_price, provider_id;

    if (isCustomBundle) {
      const { data: tests } = await supabase
        .from('provider_services')
        .select('*, providers(*)')
        .in('id', cart_items.map(item => item.id));

      if (!tests || tests.length === 0) {
        return res.status(404).json({
          success: false,
          error: 'Tests not found'
        });
      }

      provider_id = tests[0].provider_id;
      listed_price = tests.reduce((sum, test) => 
        sum + (parseFloat(test.discounted_price) || parseFloat(test.original_price) || 0), 0
      );
      
      service = {
        provider_id: provider_id,
        providers: tests[0].providers
      };
    } else {
      if (!provider_service_id) {
        return res.status(400).json({
          success: false,
          error: 'provider_service_id or cart_items required'
        });
      }

      const { data: serviceData } = await supabase
        .from('provider_services')
        .select('*, providers(*)')
        .eq('id', provider_service_id)
        .single();

      if (!serviceData) {
        return res.status(404).json({
          success: false,
          error: 'Service not found'
        });
      }

      service = serviceData;
      provider_id = service.provider_id;
      listed_price = service.discounted_price || service.original_price;
    }

    // Override listed_price if a tier was selected
    if (req.body.selected_tier_price) {
      listed_price = parseFloat(req.body.selected_tier_price);
    }

    let discount_amount = 0;

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

    const commission_rate = service.commission_rate || service.providers.base_commission_rate;
    const commission_amount = final_price * commission_rate;

    const providerCode = service.providers.provider_code.split('_')[1] || 'XXX';
    const count = await supabase
      .from('bookings')
      .select('id', { count: 'exact', head: true });
    
    const bookingNumber = String((count.count || 0) + 1).padStart(5, '0');
    const booking_reference = `HH-${providerCode}${bookingNumber}`;

    const { data: booking, error: bookingError } = await supabase
      .from('bookings')
      .insert({
        booking_reference,
        provider_id: provider_id,
        branch_id,
        provider_service_id: isCustomBundle ? null : provider_service_id,
        booking_type: isCustomBundle ? 'custom_bundle' : 'single_service',
        is_custom_bundle: isCustomBundle,
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

    if (bookingError) throw bookingError;

    if (isCustomBundle && cart_items) {
      const bookingItems = cart_items.map(item => ({
        booking_id: booking.id,
        provider_service_id: item.id,
        quantity: 1,
        item_price: parseFloat(item.discounted_price) || 0
      }));

      const { error: itemsError } = await supabase
        .from('booking_items')
        .insert(bookingItems);

      if (itemsError) {
        console.error('Error creating booking items:', itemsError);
      }
    }

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

app.get('/api/reports/bookings', async (req, res) => {
  try {
    const { provider_id, month, status } = req.query;

    let query = supabase.from('bookings').select('*');

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