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
// SMART SEARCH / CANONICAL SERVICES ENDPOINTS
// ============================================

// Get all clinical pathways
app.get('/api/clinical-pathways', async (req, res) => {
  try {
    const { data: pathways, error } = await supabase
      .from('clinical_pathways')
      .select('*')
      .order('display_order');

    if (error) throw error;

    // For each pathway, fetch the canonical service details
    for (const pathway of pathways || []) {
      if (pathway.required_canonical_ids?.length > 0) {
        const { data: required } = await supabase
          .from('canonical_services')
          .select('id, code, name_vn, name_en, category')
          .in('id', pathway.required_canonical_ids);
        pathway.required_services = required || [];
      } else {
        pathway.required_services = [];
      }

      if (pathway.recommended_canonical_ids?.length > 0) {
        const { data: recommended } = await supabase
          .from('canonical_services')
          .select('id, code, name_vn, name_en, category')
          .in('id', pathway.recommended_canonical_ids);
        pathway.recommended_services = recommended || [];
      } else {
        pathway.recommended_services = [];
      }
    }

    res.json({
      success: true,
      data: pathways || []
    });

  } catch (error) {
    console.error('Clinical pathways error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get single clinical pathway
app.get('/api/clinical-pathways/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: pathway, error } = await supabase
      .from('clinical_pathways')
      .select('*')
      .eq('id', id)
      .single();

    if (error) throw error;
    if (!pathway) {
      return res.status(404).json({ success: false, error: 'Pathway not found' });
    }

    // Fetch canonical service details
    if (pathway.required_canonical_ids?.length > 0) {
      const { data: required } = await supabase
        .from('canonical_services')
        .select('*')
        .in('id', pathway.required_canonical_ids);
      pathway.required_services = required || [];
    } else {
      pathway.required_services = [];
    }

    if (pathway.recommended_canonical_ids?.length > 0) {
      const { data: recommended } = await supabase
        .from('canonical_services')
        .select('*')
        .in('id', pathway.recommended_canonical_ids);
      pathway.recommended_services = recommended || [];
    } else {
      pathway.recommended_services = [];
    }

    res.json({ success: true, data: pathway });

  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get all canonical services
app.get('/api/canonical-services', async (req, res) => {
  try {
    const { category, search } = req.query;

    let query = supabase
      .from('canonical_services')
      .select('*')
      .order('display_order');

    if (category) {
      query = query.eq('category', category);
    }

    if (search) {
      const searchNorm = normalizeVi(search);
      query = query.or(`name_vn.ilike.%${search}%,name_en.ilike.%${search}%,code.ilike.%${search}%`);
    }

    const { data, error } = await query;

    if (error) throw error;

    res.json({
      success: true,
      data: data || []
    });

  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get providers offering a canonical service
app.get('/api/canonical-services/:id/providers', async (req, res) => {
  try {
    const { id } = req.params;

    // Get the canonical service
    const { data: canonical, error: canonicalError } = await supabase
      .from('canonical_services')
      .select('*')
      .eq('id', id)
      .single();

    if (canonicalError) throw canonicalError;
    if (!canonical) {
      return res.status(404).json({ success: false, error: 'Canonical service not found' });
    }

    // Get all provider services mapped to this canonical service
    const { data: mappings, error: mappingsError } = await supabase
      .from('provider_service_mappings')
      .select(`
        confidence_score,
        provider_services!inner (
          id,
          provider_service_name_vn,
          discounted_price,
          original_price,
          service_type,
          providers:provider_id (
            id,
            brand_name_vn,
            logo_url
          )
        )
      `)
      .eq('canonical_service_id', id);

    if (mappingsError) throw mappingsError;

    // Format response
    const providers = (mappings || []).map(m => ({
      provider_service_id: m.provider_services.id,
      provider_service_name: m.provider_services.provider_service_name_vn,
      price: m.provider_services.discounted_price || m.provider_services.original_price,
      service_type: m.provider_services.service_type,
      provider: m.provider_services.providers,
      confidence_score: m.confidence_score
    }));

    // Sort by price
    providers.sort((a, b) => (a.price || 999999999) - (b.price || 999999999));

    res.json({
      success: true,
      canonical_service: canonical,
      providers
    });

  } catch (error) {
    console.error('Canonical providers error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Smart Search - Find best packages/services for a clinical need
app.post('/api/smart-search', async (req, res) => {
  try {
    const {
      query,
      pathway_id,
      canonical_ids,
      patient_age,
      patient_gender,
      city,
      district
    } = req.body;

    let requiredCanonicalIds = [];
    let recommendedCanonicalIds = [];
    let suggestedPathway = null;

    // Case 1: Pathway ID provided directly
    if (pathway_id) {
      const { data: pathway } = await supabase
        .from('clinical_pathways')
        .select('*')
        .eq('id', pathway_id)
        .single();

      if (pathway) {
        suggestedPathway = pathway;
        requiredCanonicalIds = pathway.required_canonical_ids || [];
        recommendedCanonicalIds = pathway.recommended_canonical_ids || [];
      }
    }
    // Case 2: Specific canonical IDs provided
    else if (canonical_ids && canonical_ids.length > 0) {
      requiredCanonicalIds = canonical_ids;
    }
    // Case 3: Free-text query - find matching pathway
    else if (query) {
      const queryNorm = normalizeVi(query);
      const queryWords = queryNorm.split(' ').filter(w => w.length >= 2);

      // Search pathways by keywords
      const { data: pathways } = await supabase
        .from('clinical_pathways')
        .select('*')
        .order('is_common', { ascending: false });

      // Score pathways based on keyword matches
      let bestPathway = null;
      let bestScore = 0;

      for (const pathway of pathways || []) {
        let score = 0;
        const keywords = pathway.trigger_keywords || [];
        const symptoms = pathway.trigger_symptoms || [];

        // HIGHEST PRIORITY: Exact keyword match (query contains full keyword)
        for (const kw of keywords) {
          const kwNorm = normalizeVi(kw);
          if (queryNorm === kwNorm) {
            // Exact match - highest score
            score += 100;
          } else if (queryNorm.includes(kwNorm)) {
            // Query contains the keyword phrase
            score += 50;
          }
        }

        // MEDIUM PRIORITY: Keyword contains full query (e.g., query="tiểu đường", keyword="tầm soát tiểu đường")
        for (const kw of keywords) {
          const kwNorm = normalizeVi(kw);
          if (kwNorm.includes(queryNorm) && queryNorm.length >= 5) {
            score += 30;
          }
        }

        // LOW PRIORITY: Word-level matching (only if no exact matches found)
        // Require words to be at least 4 chars to avoid false matches like "đau" matching "đau khớp"
        let wordMatchCount = 0;
        for (const word of queryWords) {
          if (word.length < 4) continue; // Skip short words (e.g., "dau", "gan")

          for (const kw of keywords) {
            const kwNorm = normalizeVi(kw);
            // Only match if word is a complete word in keyword (not partial)
            const kwWords = kwNorm.split(' ');
            if (kwWords.includes(word)) {
              wordMatchCount++;
              score += 5;
            }
          }
          for (const sym of symptoms) {
            if (normalizeVi(sym).includes(word) && word.length >= 4) {
              score += 2;
            }
          }
        }

        // Bonus for matching multiple words
        if (wordMatchCount >= 2) {
          score += 15;
        }

        // Age/gender filtering
        if (patient_age) {
          if (pathway.target_age_min && patient_age < pathway.target_age_min) {
            score -= 5;
          }
          if (pathway.target_age_max && patient_age > pathway.target_age_max) {
            score -= 5;
          }
        }

        if (patient_gender && pathway.target_gender && pathway.target_gender !== 'all') {
          if (pathway.target_gender !== patient_gender) {
            score -= 10;
          }
        }

        if (score > bestScore) {
          bestScore = score;
          bestPathway = pathway;
        }
      }

      // Require minimum score of 10 to avoid false positives from weak partial matches
      if (bestPathway && bestScore >= 10) {
        suggestedPathway = bestPathway;
        requiredCanonicalIds = bestPathway.required_canonical_ids || [];
        recommendedCanonicalIds = bestPathway.recommended_canonical_ids || [];
      }
    }

    // If no canonical IDs found, return empty
    if (requiredCanonicalIds.length === 0 && recommendedCanonicalIds.length === 0) {
      return res.json({
        success: true,
        suggested_pathway: null,
        results: {
          complete_packages: [],
          partial_packages: [],
          individual_options: null
        }
      });
    }

    // Get canonical service details
    const allCanonicalIds = [...new Set([...requiredCanonicalIds, ...recommendedCanonicalIds])];
    const { data: canonicalServices } = await supabase
      .from('canonical_services')
      .select('*')
      .in('id', allCanonicalIds);

    // Find provider services that cover these canonical services
    const { data: mappings } = await supabase
      .from('provider_service_mappings')
      .select(`
        canonical_service_id,
        confidence_score,
        provider_services!inner (
          id,
          provider_id,
          provider_service_name_vn,
          service_type,
          discounted_price,
          original_price,
          pricing_data,
          providers:provider_id (
            id,
            brand_name_vn,
            logo_url
          )
        )
      `)
      .in('canonical_service_id', allCanonicalIds);

    // Group by provider_service_id to see coverage
    const serviceMap = new Map();

    for (const m of mappings || []) {
      const psId = m.provider_services.id;
      if (!serviceMap.has(psId)) {
        serviceMap.set(psId, {
          ...m.provider_services,
          matched_canonical_ids: [],
          total_confidence: 0
        });
      }
      serviceMap.get(psId).matched_canonical_ids.push(m.canonical_service_id);
      serviceMap.get(psId).total_confidence += m.confidence_score;
    }

    // Calculate coverage scores
    const services = Array.from(serviceMap.values()).map(s => {
      const requiredMatched = s.matched_canonical_ids.filter(id => requiredCanonicalIds.includes(id));
      const recommendedMatched = s.matched_canonical_ids.filter(id => recommendedCanonicalIds.includes(id));

      const requiredCoverage = requiredCanonicalIds.length > 0
        ? requiredMatched.length / requiredCanonicalIds.length
        : 0;

      const totalCoverage = allCanonicalIds.length > 0
        ? s.matched_canonical_ids.length / allCanonicalIds.length
        : 0;

      return {
        ...s,
        required_coverage: requiredCoverage,
        total_coverage: totalCoverage,
        required_matched: requiredMatched,
        recommended_matched: recommendedMatched,
        price: s.discounted_price || s.original_price || 0
      };
    });

    // Separate into complete packages, partial packages, and atomics
    const completePackages = services
      .filter(s => s.service_type === 'package' && s.required_coverage >= 0.99)
      .sort((a, b) => b.total_coverage - a.total_coverage || a.price - b.price);

    const partialPackages = services
      .filter(s => s.service_type === 'package' && s.required_coverage >= 0.5 && s.required_coverage < 0.99)
      .sort((a, b) => b.required_coverage - a.required_coverage || a.price - b.price);

    // For individual options, find cheapest atomic for each required canonical
    const individualOptions = [];
    const atomicServices = services.filter(s => s.service_type === 'atomic');

    for (const canonicalId of requiredCanonicalIds) {
      const matching = atomicServices
        .filter(s => s.matched_canonical_ids.includes(canonicalId))
        .sort((a, b) => a.price - b.price);

      if (matching.length > 0) {
        const cheapest = matching[0];
        individualOptions.push({
          canonical_id: canonicalId,
          canonical_service: canonicalServices?.find(cs => cs.id === canonicalId),
          provider_service: cheapest,
          price: cheapest.price
        });
      }
    }

    const individualTotal = individualOptions.reduce((sum, opt) => sum + opt.price, 0);

    // Enrich pathway with service details
    if (suggestedPathway) {
      suggestedPathway.required_services = canonicalServices?.filter(
        cs => requiredCanonicalIds.includes(cs.id)
      ) || [];
      suggestedPathway.recommended_services = canonicalServices?.filter(
        cs => recommendedCanonicalIds.includes(cs.id)
      ) || [];
    }

    res.json({
      success: true,
      suggested_pathway: suggestedPathway,
      canonical_services: canonicalServices,
      results: {
        complete_packages: completePackages.slice(0, 5).map(p => ({
          provider_service_id: p.id,
          name: p.provider_service_name_vn,
          provider: p.providers,
          coverage_score: p.total_coverage,
          price: p.price,
          pricing_data: p.pricing_data,
          matched_required: p.required_matched.length,
          matched_recommended: p.recommended_matched.length,
          total_required: requiredCanonicalIds.length,
          total_recommended: recommendedCanonicalIds.length
        })),
        partial_packages: partialPackages.slice(0, 5).map(p => ({
          provider_service_id: p.id,
          name: p.provider_service_name_vn,
          provider: p.providers,
          coverage_score: p.required_coverage,
          price: p.price,
          missing_canonical_ids: requiredCanonicalIds.filter(id => !p.required_matched.includes(id))
        })),
        individual_options: individualOptions.length > 0 ? {
          total_price: individualTotal,
          services: individualOptions
        } : null
      }
    });

  } catch (error) {
    console.error('Smart search error:', error);
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

// ============================================
// DATABASE SETUP VERIFICATION
// ============================================

// Check if canonical tables exist and have data
app.get('/api/setup/status', async (req, res) => {
  const status = {
    tables: {},
    ready: true,
    missing_steps: []
  };

  // Check canonical_services table
  try {
    const { data, error } = await supabase
      .from('canonical_services')
      .select('id', { count: 'exact', head: true });

    if (error) throw error;
    status.tables.canonical_services = { exists: true, count: data?.length || 0 };
  } catch (e) {
    status.tables.canonical_services = { exists: false, error: e.message };
    status.ready = false;
    status.missing_steps.push('Create canonical_services table');
  }

  // Check clinical_pathways table
  try {
    const { data, error } = await supabase
      .from('clinical_pathways')
      .select('id', { count: 'exact', head: true });

    if (error) throw error;
    status.tables.clinical_pathways = { exists: true, count: data?.length || 0 };
  } catch (e) {
    status.tables.clinical_pathways = { exists: false, error: e.message };
    status.ready = false;
    status.missing_steps.push('Create clinical_pathways table');
  }

  // Check provider_service_mappings table
  try {
    const { data, error } = await supabase
      .from('provider_service_mappings')
      .select('id', { count: 'exact', head: true });

    if (error) throw error;
    status.tables.provider_service_mappings = { exists: true, count: data?.length || 0 };
  } catch (e) {
    status.tables.provider_service_mappings = { exists: false, error: e.message };
    status.ready = false;
    status.missing_steps.push('Create provider_service_mappings table');
  }

  // Check if tables have data
  if (status.tables.canonical_services?.exists && status.tables.canonical_services?.count === 0) {
    status.missing_steps.push('Seed canonical_services with data');
  }
  if (status.tables.clinical_pathways?.exists && status.tables.clinical_pathways?.count === 0) {
    status.missing_steps.push('Seed clinical_pathways with data');
  }

  res.json({
    success: true,
    status,
    setup_instructions: !status.ready ? {
      step1: 'Run SQL in Supabase SQL Editor: migrations/001_create_canonical_tables.sql',
      step2: 'Run: python3 scripts/seed_canonical_services.py',
      step3: 'Run: python3 scripts/seed_clinical_pathways.py',
      step4: 'Run: python3 scripts/auto_map_services.py'
    } : null
  });
});

// ============================================
// SIMPLIFIED CATALOG SEARCH (V2)
// ============================================

// Helper: Parse location from search query
// Examples: "kham thai quan 5" -> { service: "kham thai", district: "Quận 5" }
//           "xet nghiem mau hcm" -> { service: "xet nghiem mau", city: "Hồ Chí Minh" }
function parseLocationFromQuery(query) {
  const queryNorm = normalizeVi(query.toLowerCase());
  let serviceQuery = query;
  let detectedDistrict = null;
  let detectedCity = null;

  // District patterns (Vietnamese)
  // Matches: "quan 5", "q5", "q.5", "q 5", "quận 5", "quan5"
  const districtPatterns = [
    /\b(?:quan|q\.?)\s*(\d{1,2})\b/i,           // quan 5, q5, q.5, q 5
    /\bquan\s+(binh\s*thanh|tan\s*binh|phu\s*nhuan|go\s*vap|binh\s*tan|tan\s*phu|thu\s*duc|binh\s*chanh|hoc\s*mon|cu\s*chi|can\s*gio|nha\s*be)\b/i,  // named districts
    /\b(binh\s*thanh|tan\s*binh|phu\s*nhuan|go\s*vap|binh\s*tan|tan\s*phu|thu\s*duc)\b/i,  // named districts without "quan"
  ];

  // City patterns
  const cityMappings = {
    'hcm': 'Hồ Chí Minh',
    'tphcm': 'Hồ Chí Minh',
    'ho chi minh': 'Hồ Chí Minh',
    'tp ho chi minh': 'Hồ Chí Minh',
    'sai gon': 'Hồ Chí Minh',
    'sg': 'Hồ Chí Minh',
    'hn': 'Hà Nội',
    'ha noi': 'Hà Nội',
    'tp ha noi': 'Hà Nội',
    'da nang': 'Đà Nẵng',
    'dn': 'Đà Nẵng',
  };

  // Named district mappings (normalized -> display)
  const namedDistrictMappings = {
    'binh thanh': 'Bình Thạnh',
    'tan binh': 'Tân Bình',
    'phu nhuan': 'Phú Nhuận',
    'go vap': 'Gò Vấp',
    'binh tan': 'Bình Tân',
    'tan phu': 'Tân Phú',
    'thu duc': 'Thủ Đức',
    'binh chanh': 'Bình Chánh',
    'hoc mon': 'Hóc Môn',
    'cu chi': 'Củ Chi',
    'can gio': 'Cần Giờ',
    'nha be': 'Nhà Bè',
  };

  // Check for numbered districts (quan 5, q5, etc.)
  const numberedDistrictMatch = queryNorm.match(/\b(?:quan|q\.?)\s*(\d{1,2})\b/i);
  if (numberedDistrictMatch) {
    const districtNum = numberedDistrictMatch[1];
    detectedDistrict = `Quận ${districtNum}`;
    // Remove the district part from query
    serviceQuery = query.replace(/\b(?:quận|quan|q\.?)\s*\d{1,2}\b/gi, '').trim();
  }

  // Check for named districts
  if (!detectedDistrict) {
    for (const [normName, displayName] of Object.entries(namedDistrictMappings)) {
      const pattern = new RegExp(`\\b(?:quan\\s+)?${normName.replace(/\s+/g, '\\s*')}\\b`, 'i');
      if (pattern.test(queryNorm)) {
        detectedDistrict = displayName;
        // Remove the district part from query
        const removePattern = new RegExp(`\\b(?:quận\\s+|quan\\s+)?${normName.replace(/\s+/g, '\\s*')}\\b`, 'gi');
        serviceQuery = serviceQuery.replace(removePattern, '').trim();
        break;
      }
    }
  }

  // Check for cities
  for (const [pattern, cityName] of Object.entries(cityMappings)) {
    const cityPattern = new RegExp(`\\b${pattern.replace(/\s+/g, '\\s*')}\\b`, 'i');
    if (cityPattern.test(queryNorm)) {
      detectedCity = cityName;
      // Remove city from query
      const removePattern = new RegExp(`\\b${pattern.replace(/\s+/g, '\\s*')}\\b`, 'gi');
      serviceQuery = serviceQuery.replace(removePattern, '').trim();
      break;
    }
  }

  // Clean up extra spaces
  serviceQuery = serviceQuery.replace(/\s+/g, ' ').trim();

  return {
    serviceQuery,
    district: detectedDistrict,
    city: detectedCity
  };
}

// Main search endpoint - returns services with location info
app.get('/api/v2/search', async (req, res) => {
  try {
    const {
      q,           // Search query (may include location like "kham thai quan 5")
      city: explicitCity,        // Explicit city filter
      district: explicitDistrict,    // Explicit district filter
      provider_id, // Filter by provider
      limit = 50
    } = req.query;

    if (!q || q.length < 2) {
      return res.json({
        success: true,
        packages: [],
        services: [],
        total: 0
      });
    }

    // Parse location from query string
    const parsed = parseLocationFromQuery(q);
    const serviceQuery = parsed.serviceQuery;
    const city = explicitCity || parsed.city;
    const district = explicitDistrict || parsed.district;

    // If only location was in query (no service terms), return empty
    if (!serviceQuery || serviceQuery.length < 2) {
      return res.json({
        success: true,
        packages: [],
        services: [],
        total: 0,
        query: q,
        parsed: { serviceQuery, city, district }
      });
    }

    const queryNorm = normalizeVi(serviceQuery);
    const queryWords = queryNorm.split(' ').filter(w => w.length >= 2);

    // Get all active services matching the query
    let query = supabase
      .from('provider_services')
      .select(`
        id,
        provider_service_name_vn,
        short_description,
        service_type,
        discounted_price,
        pricing_data,
        keywords,
        provider_id,
        providers:provider_id (
          id,
          brand_name_vn
        )
      `)
      .eq('status', 'active')
      .eq('is_bookable', true)
      .is('deleted_at', null)
      .not('discounted_price', 'is', null);

    // Apply provider filter if specified
    if (provider_id) {
      query = query.eq('provider_id', provider_id);
    }

    // Text search
    if (queryWords.length > 0) {
      const searchConditions = queryWords.map(word =>
        `keywords.ilike.%${word}%,provider_service_name_vn.ilike.%${word}%`
      ).join(',');
      query = query.or(searchConditions);
    }

    const { data: services, error } = await query.limit(300);
    if (error) throw error;

    // Get branch availability for all services
    const serviceIds = services?.map(s => s.id) || [];

    let branchMap = {};
    if (serviceIds.length > 0) {
      const { data: branchServices } = await supabase
        .from('branch_services')
        .select(`
          provider_service_id,
          branches:branch_id (
            id,
            branch_name_vn,
            district,
            city,
            address
          )
        `)
        .in('provider_service_id', serviceIds)
        .eq('is_available', true);

      // Build map of service_id -> branches
      branchServices?.forEach(bs => {
        if (!branchMap[bs.provider_service_id]) {
          branchMap[bs.provider_service_id] = [];
        }
        if (bs.branches) {
          branchMap[bs.provider_service_id].push(bs.branches);
        }
      });
    }

    // Get package components for packages
    const packageIds = services?.filter(s => s.service_type === 'package').map(s => s.id) || [];
    let componentMap = {};

    if (packageIds.length > 0) {
      const { data: components } = await supabase
        .from('provider_services')
        .select('id, provider_service_name_vn, parent_service_id')
        .in('parent_service_id', packageIds)
        .eq('status', 'active');

      components?.forEach(c => {
        if (!componentMap[c.parent_service_id]) {
          componentMap[c.parent_service_id] = [];
        }
        componentMap[c.parent_service_id].push({
          id: c.id,
          name: c.provider_service_name_vn
        });
      });
    }

    // Calculate relevance and build results with SOFT location boost
    const cityNorm = city ? normalizeVi(city) : null;
    const districtNorm = district ? normalizeVi(district) : null;

    let results = (services || []).map(service => {
      const branches = branchMap[service.id] || [];

      // Skip services with no branches
      if (branches.length === 0) return null;

      // Categorize branches by location match
      const matchedBranches = [];
      const nearbyBranches = [];
      const otherBranches = [];

      branches.forEach(b => {
        const branchDistrictNorm = normalizeVi(b.district || '');
        const branchCityNorm = normalizeVi(b.city || '');

        // Check district match
        const districtMatch = districtNorm && branchDistrictNorm.includes(districtNorm);
        // Check city match
        const cityMatch = cityNorm && branchCityNorm.includes(cityNorm);

        if (districtMatch) {
          matchedBranches.push({ ...b, matchType: 'district' });
        } else if (cityMatch) {
          nearbyBranches.push({ ...b, matchType: 'city' });
        } else {
          otherBranches.push({ ...b, matchType: 'other' });
        }
      });

      // Calculate TEXT relevance score
      const name = normalizeVi(service.provider_service_name_vn || '');
      const desc = normalizeVi(service.short_description || '');
      const keywords = (service.keywords || '').toLowerCase();

      let textScore = 0;
      if (name === queryNorm) textScore += 1000;
      else if (name.startsWith(queryNorm)) textScore += 500;
      else if (name.includes(queryNorm)) textScore += 300;

      queryWords.forEach(word => {
        if (name.includes(word)) textScore += 50;
        if (keywords.includes(word)) textScore += 20;
        if (desc.includes(word)) textScore += 10;
      });

      // Skip if no text relevance
      if (textScore === 0) return null;

      // Calculate LOCATION boost (soft boost, not hard filter)
      let locationBoost = 0;
      let locationMatch = 'none';

      if (matchedBranches.length > 0) {
        locationBoost = 500; // Strong boost for exact district match
        locationMatch = 'district';
      } else if (nearbyBranches.length > 0) {
        locationBoost = 200; // Medium boost for same city
        locationMatch = 'city';
      }
      // No boost if no location match, but still include in results

      // Prominence boost (more branches = more prominent)
      const prominenceBoost = Math.min(branches.length * 5, 50);

      // Final score
      const finalScore = textScore + locationBoost + prominenceBoost;

      // Sort branches: matched first, then nearby, then others
      const sortedBranches = [...matchedBranches, ...nearbyBranches, ...otherBranches];

      return {
        id: service.id,
        name: service.provider_service_name_vn,
        description: service.short_description,
        price: service.discounted_price,
        pricing_data: service.pricing_data,
        type: service.service_type,
        provider: {
          id: service.providers?.id,
          name: service.providers?.brand_name_vn
        },
        // Location matching info
        location_match: locationMatch,
        matched_branches: matchedBranches.slice(0, 5).map(b => ({
          id: b.id,
          name: b.branch_name_vn,
          district: b.district,
          city: b.city,
          address: b.address
        })),
        matched_branch_count: matchedBranches.length,
        nearby_branch_count: nearbyBranches.length,
        other_branch_count: otherBranches.length,
        total_branch_count: branches.length,
        // Primary branch for display (first matched, or first overall)
        primary_branch: sortedBranches[0] ? {
          id: sortedBranches[0].id,
          name: sortedBranches[0].branch_name_vn,
          district: sortedBranches[0].district,
          city: sortedBranches[0].city,
          address: sortedBranches[0].address
        } : null,
        components: service.service_type === 'package' ? (componentMap[service.id] || []) : null,
        _score: finalScore,
        _textScore: textScore,
        _locationBoost: locationBoost
      };
    }).filter(Boolean);

    // Sort by final score (includes location boost)
    results.sort((a, b) => b._score - a._score);

    // Split into packages and services
    const packages = results
      .filter(r => r.type === 'package')
      .slice(0, parseInt(limit));

    const individualServices = results
      .filter(r => r.type === 'atomic')
      .slice(0, parseInt(limit));

    // Check if location was requested but no exact matches found
    const hasLocationFilter = !!(city || district);
    const hasExactMatches = results.some(r => r.location_match === 'district');

    res.json({
      success: true,
      packages,
      services: individualServices,
      total: packages.length + individualServices.length,
      query: q,
      parsed: {
        serviceQuery,
        city: city || null,
        district: district || null
      },
      location_info: hasLocationFilter ? {
        requested_district: district,
        requested_city: city,
        has_exact_matches: hasExactMatches,
        message: hasExactMatches
          ? `Hiển thị kết quả tại ${district || city}`
          : `Không có chi nhánh tại ${district || city}, hiển thị khu vực lân cận`
      } : null
    });

  } catch (error) {
    console.error('V2 Search error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get branches for a specific service
app.get('/api/v2/services/:id/branches', async (req, res) => {
  try {
    const { id } = req.params;
    const { city, district } = req.query;

    const { data: branchServices, error } = await supabase
      .from('branch_services')
      .select(`
        branches:branch_id (
          id,
          branch_name_vn,
          district,
          city,
          address,
          phone,
          notification_email,
          operating_hours
        )
      `)
      .eq('provider_service_id', id)
      .eq('is_available', true);

    if (error) throw error;

    let branches = branchServices?.map(bs => bs.branches).filter(Boolean) || [];

    // Apply location filters
    if (city || district) {
      branches = branches.filter(b => {
        const matchCity = !city || normalizeVi(b.city || '').includes(normalizeVi(city));
        const matchDistrict = !district || normalizeVi(b.district || '').includes(normalizeVi(district));
        return matchCity && matchDistrict;
      });
    }

    res.json({
      success: true,
      data: branches,
      total: branches.length
    });

  } catch (error) {
    console.error('Get branches error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Health check
// ============================================
// DATA MIGRATION: Fix keywords for better search
// ============================================
app.post('/api/admin/fix-keywords', async (req, res) => {
  try {
    // Get all services
    const { data: services, error } = await supabase
      .from('provider_services')
      .select('id, provider_service_name_vn, keywords')
      .eq('status', 'active');

    if (error) throw error;

    // Keyword mappings by category
    const categories = {
      diabetes: {
        patterns: ['đái tháo', 'glucose', 'đường huyết', 'hba1c', 'insulin', 'dung nạp'],
        keywords: 'tieu duong, dai thao duong, duong huyet, glucose, insulin, tieu duong type 2'
      },
      bone: {
        patterns: ['xương', 'loãng xương', 'canxi', 'vitamin d', 'bone'],
        keywords: 'xuong, khop, xuong khop, loang xuong, canxi, vitamin d'
      },
      cardiac: {
        patterns: ['tim mạch', 'cardiac', 'cholesterol', 'lipid', 'triglycerid'],
        keywords: 'tim mach, tim, huyet ap, cholesterol, lipid, cardiac, mo mau'
      },
      thyroid: {
        patterns: ['giáp', 'thyroid', 'tsh', 't3', 't4'],
        keywords: 'tuyen giap, giap, thyroid, tsh, cuong giap, suy giap'
      },
      allergy: {
        patterns: ['dị ứng', 'allerg', 'ige', 'miễn dịch'],
        keywords: 'di ung, allergy, ige, man ngua, noi man, mien dich'
      },
      infectious: {
        patterns: ['viêm gan', 'hiv', 'std', 'lây', 'truyền nhiễm', 'bệnh xã hội'],
        keywords: 'truyen nhiem, lay nhiem, viem gan, hiv, std, benh xa hoi'
      }
    };

    const updates = [];

    for (const service of services || []) {
      const name = (service.provider_service_name_vn || '').toLowerCase();
      const currentKw = (service.keywords || '').toLowerCase();
      let newKeywords = new Set(currentKw.split(',').map(k => k.trim()).filter(Boolean));

      for (const [cat, info] of Object.entries(categories)) {
        const matches = info.patterns.some(p => name.includes(p.toLowerCase()));
        if (matches) {
          info.keywords.split(',').map(k => k.trim()).forEach(kw => {
            if (!currentKw.includes(kw)) {
              newKeywords.add(kw);
            }
          });
        }
      }

      const newKwString = Array.from(newKeywords).join(', ');
      if (newKwString !== currentKw && newKeywords.size > currentKw.split(',').length) {
        updates.push({
          id: service.id,
          name: service.provider_service_name_vn,
          old_keywords: service.keywords,
          new_keywords: newKwString
        });
      }
    }

    // Apply updates
    let updated = 0;
    for (const update of updates) {
      const { error: updateError } = await supabase
        .from('provider_services')
        .update({ keywords: update.new_keywords })
        .eq('id', update.id);

      if (!updateError) updated++;
    }

    res.json({
      success: true,
      total_services: services?.length || 0,
      updates_needed: updates.length,
      updates_applied: updated,
      sample_updates: updates.slice(0, 10)
    });

  } catch (error) {
    console.error('Fix keywords error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// DATA MIGRATION: Fix missing package components
// ============================================
app.post('/api/admin/fix-package-components', async (req, res) => {
  try {
    // Get all packages
    const { data: packages, error } = await supabase
      .from('provider_services')
      .select('id, provider_service_name_vn, service_type')
      .eq('service_type', 'package')
      .eq('status', 'active')
      .is('parent_service_id', null);

    if (error) throw error;

    // Get existing components
    const { data: components } = await supabase
      .from('provider_services')
      .select('id, parent_service_id, provider_service_name_vn')
      .not('parent_service_id', 'is', null);

    // Build map of package -> components
    const componentMap = {};
    for (const c of components || []) {
      if (!componentMap[c.parent_service_id]) {
        componentMap[c.parent_service_id] = [];
      }
      componentMap[c.parent_service_id].push(c);
    }

    // Find packages without components
    const packagesWithoutComponents = [];
    for (const pkg of packages || []) {
      const comps = componentMap[pkg.id] || [];
      if (comps.length === 0) {
        packagesWithoutComponents.push({
          id: pkg.id,
          name: pkg.provider_service_name_vn,
          component_count: 0
        });
      }
    }

    res.json({
      success: true,
      total_packages: packages?.length || 0,
      packages_with_components: packages.length - packagesWithoutComponents.length,
      packages_without_components: packagesWithoutComponents.length,
      missing_components: packagesWithoutComponents
    });

  } catch (error) {
    console.error('Fix components error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// DATA MIGRATION: Fix district field in branches
// ============================================
app.post('/api/admin/fix-branch-districts', async (req, res) => {
  try {
    // Get all branches
    const { data: branches, error } = await supabase
      .from('branches')
      .select('id, branch_name_vn, district');

    if (error) throw error;

    // Parse district from branch_name_vn
    // Examples:
    // "Quận 5 – Nguyễn Trãi" -> "Quận 5"
    // "Quận Tân Bình – Lạc Long Quân" -> "Quận Tân Bình"
    // "Quận Bình Thạnh – Xô Viết Nghệ Tĩnh" -> "Quận Bình Thạnh"
    const updates = [];

    for (const branch of branches || []) {
      const name = branch.branch_name_vn || '';
      let newDistrict = null;

      // Pattern 1: "Quận X – ..." where X is a number
      const numberedMatch = name.match(/^(Quận\s*\d+)/i);
      if (numberedMatch) {
        newDistrict = numberedMatch[1];
      }

      // Pattern 2: "Quận [Name] – ..." for named districts
      if (!newDistrict) {
        const namedMatch = name.match(/^(Quận\s+(?:Tân Bình|Bình Thạnh|Phú Nhuận|Gò Vấp|Bình Tân|Tân Phú|Thủ Đức))/i);
        if (namedMatch) {
          newDistrict = namedMatch[1];
        }
      }

      // Pattern 3: "Huyện [Name] – ..." for rural districts
      if (!newDistrict) {
        const huyenMatch = name.match(/^(Huyện\s+(?:Bình Chánh|Hóc Môn|Củ Chi|Cần Giờ|Nhà Bè))/i);
        if (huyenMatch) {
          newDistrict = huyenMatch[1];
        }
      }

      // Pattern 4: "TP. Thủ Đức – ..."
      if (!newDistrict) {
        const tpMatch = name.match(/^(TP\.?\s*Thủ Đức)/i);
        if (tpMatch) {
          newDistrict = 'TP. Thủ Đức';
        }
      }

      if (newDistrict && newDistrict !== branch.district) {
        updates.push({
          id: branch.id,
          old_district: branch.district,
          new_district: newDistrict,
          branch_name: name
        });
      }
    }

    // Perform updates
    let updated = 0;
    for (const update of updates) {
      const { error: updateError } = await supabase
        .from('branches')
        .update({ district: update.new_district })
        .eq('id', update.id);

      if (!updateError) updated++;
    }

    res.json({
      success: true,
      total_branches: branches?.length || 0,
      updates_needed: updates.length,
      updates_applied: updated,
      details: updates.slice(0, 20) // Show first 20 for verification
    });

  } catch (error) {
    console.error('Fix district error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Start server
app.listen(PORT, () => {
  console.log(`\n✅ API Server running on http://localhost:${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/health\n`);
});